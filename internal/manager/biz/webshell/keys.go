package webshell

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"

	settingmodel "github.com/ongridio/ongrid/internal/manager/model/setting"
)

// KeyStore is the narrow settings surface Keys needs. Defined on the
// consumer side; *biz/setting.Service satisfies it.
type KeyStore interface {
	Get(ctx context.Context, category, key string) (string, bool, error)
	SetIfAbsent(ctx context.Context, category, key, value string, sensitive bool) error
}

// Keys holds the manager's WebSSH SSH key material: a signer used to
// authenticate to edge hosts' sshd, and the matching authorized_keys line
// install.sh drops into the target user's ~/.ssh/authorized_keys.
type Keys struct {
	signer         ssh.Signer
	authorizedLine string
}

// AuthorizedKeyComment tags the authorized_keys line so install / uninstall
// can locate (and remove) exactly the ongrid-managed entry.
const AuthorizedKeyComment = "ongrid-webssh"

// LoadOrCreateKeys returns the persisted WebSSH keypair, generating and
// persisting a fresh ed25519 key on first call. The private key is stored
// PEM-encoded (PKCS#8) in system_settings under (webssh, private_key),
// flagged sensitive so list endpoints mask it.
func LoadOrCreateKeys(ctx context.Context, store KeyStore) (*Keys, error) {
	pemStr, found, err := store.Get(ctx, settingmodel.CategoryWebSSH, settingmodel.KeyWebSSHPrivateKey)
	if err != nil {
		return nil, fmt.Errorf("load webssh key: %w", err)
	}
	if !found || strings.TrimSpace(pemStr) == "" {
		generated, gerr := generatePrivateKeyPEM()
		if gerr != nil {
			return nil, gerr
		}
		if serr := store.SetIfAbsent(ctx, settingmodel.CategoryWebSSH, settingmodel.KeyWebSSHPrivateKey, generated, true); serr != nil {
			return nil, fmt.Errorf("persist webssh key: %w", serr)
		}
		// Re-read so that if a concurrent first boot won the upsert, every
		// manager ends up using the same persisted key.
		stored, ok, rerr := store.Get(ctx, settingmodel.CategoryWebSSH, settingmodel.KeyWebSSHPrivateKey)
		if rerr != nil {
			return nil, fmt.Errorf("reload webssh key: %w", rerr)
		}
		if ok && strings.TrimSpace(stored) != "" {
			pemStr = stored
		} else {
			pemStr = generated
		}
	}
	return keysFromPEM(pemStr)
}

// generatePrivateKeyPEM creates a fresh ed25519 key, PKCS#8 + PEM encoded.
func generatePrivateKeyPEM() (string, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("generate ed25519: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", fmt.Errorf("marshal pkcs8: %w", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}

// keysFromPEM parses a PEM private key into a signer + authorized_keys line.
func keysFromPEM(pemStr string) (*Keys, error) {
	signer, err := ssh.ParsePrivateKey([]byte(pemStr))
	if err != nil {
		return nil, fmt.Errorf("parse webssh key: %w", err)
	}
	// from="127.0.0.1,::1" pins the key to localhost-origin connections.
	// WebSSH always reaches the host's sshd via the edge dialing
	// 127.0.0.1:22, so sshd sees a local source — a leaked key still cannot
	// be used to log in from another machine.
	pub := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	authLine := fmt.Sprintf("from=\"127.0.0.1,::1\" %s %s\n", pub, AuthorizedKeyComment)
	return &Keys{signer: signer, authorizedLine: authLine}, nil
}

// Signer is the SSH client auth signer used by the webshell handler.
func (k *Keys) Signer() ssh.Signer { return k.signer }

// AuthorizedKeyLine is the single-line authorized_keys entry served to
// install.sh (trailing newline included).
func (k *Keys) AuthorizedKeyLine() string { return k.authorizedLine }
