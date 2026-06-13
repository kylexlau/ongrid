package webshell

import (
	"context"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"

	settingmodel "github.com/ongridio/ongrid/internal/manager/model/setting"
)

// memStore is an in-memory KeyStore for the keypair tests.
type memStore struct {
	mu   sync.Mutex
	data map[string]string
}

func newMemStore() *memStore { return &memStore{data: map[string]string{}} }

func (m *memStore) Get(_ context.Context, category, key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.data[category+"/"+key]
	return v, ok, nil
}

func (m *memStore) SetIfAbsent(_ context.Context, category, key, value string, _ bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := category + "/" + key
	if _, ok := m.data[k]; ok {
		return nil
	}
	m.data[k] = value
	return nil
}

func TestLoadOrCreateKeysGeneratesAndPersists(t *testing.T) {
	store := newMemStore()
	ctx := context.Background()

	k, err := LoadOrCreateKeys(ctx, store)
	if err != nil {
		t.Fatalf("LoadOrCreateKeys: %v", err)
	}
	if k.Signer() == nil {
		t.Fatal("signer is nil")
	}
	// A private key row must now be persisted (sensitive material).
	pem, ok, _ := store.Get(ctx, settingmodel.CategoryWebSSH, settingmodel.KeyWebSSHPrivateKey)
	if !ok || !strings.Contains(pem, "PRIVATE KEY") {
		t.Fatalf("private key not persisted: ok=%v pem=%q", ok, pem)
	}

	// authorized_keys line: localhost-pinned + tagged comment + valid key.
	line := k.AuthorizedKeyLine()
	if !strings.HasPrefix(line, `from="127.0.0.1,::1" `) {
		t.Errorf("missing from= restriction: %q", line)
	}
	if !strings.Contains(line, AuthorizedKeyComment) {
		t.Errorf("missing comment tag: %q", line)
	}
	if !strings.HasSuffix(line, "\n") {
		t.Errorf("authorized line must end with newline: %q", line)
	}
	// The key field must parse back as a real SSH public key.
	fields := strings.Fields(strings.TrimSpace(line))
	// fields: from=..., type, base64, comment
	if _, _, _, _, perr := ssh.ParseAuthorizedKey([]byte(strings.Join(fields[1:], " "))); perr != nil {
		t.Errorf("authorized key does not parse: %v", perr)
	}
}

func TestLoadOrCreateKeysIsStableAcrossCalls(t *testing.T) {
	store := newMemStore()
	ctx := context.Background()

	k1, err := LoadOrCreateKeys(ctx, store)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	k2, err := LoadOrCreateKeys(ctx, store)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if k1.AuthorizedKeyLine() != k2.AuthorizedKeyLine() {
		t.Error("authorized key changed across calls; key was not reused from store")
	}
}
