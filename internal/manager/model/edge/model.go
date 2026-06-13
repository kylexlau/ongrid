// Package edge holds persistence entities for the manager/edge sub-domain.
//
// Post-split (May 2026): host facts (hostname, OS, hardware, roles, live
// usage) live on model/device.Device, linked here through the M:N
// `edge_devices` junction (model/device.EdgeDevice). The Edge row owns
// the agent identity (access key, online/offline, last_seen_at, name).
// Code that needs to display the host alongside an edge should resolve
// the host Device through edge_devices(type=host).
//
// The legacy Edge.DeviceID 1:1 link column is retained at the Go layer
// (read-only convenience pointer to the host device) so existing callers
// keep compiling, but the source of truth for "which device(s) does this
// edge own" is the junction table.
package edge

import (
	"time"

	"gorm.io/gorm"
)

// Edge is a registered edge agent (a tunnel-side identity). Post-pivot
// there is no org_id; CreatedBy records which user registered
// it (nullable FK to users.id, audit only). DeletedAt is a gorm
// soft-delete marker; gorm automatically filters rows with DeletedAt IS
// NOT NULL out of default queries.
//
// Post-split (May 2026): device-y fields (Hostname/OS/HW/Roles/usage)
// have moved to model/device.Device. Edge keeps tunnel-y fields only.
type Edge struct {
	ID            uint64 `gorm:"primaryKey;autoIncrement"`
	// Name is the operator-friendly display name. Optional at create
	// time — when left empty, edge.HandleRegister auto-fills it with
	// the host's reported hostname on first tunnel handshake.
	Name          string `gorm:"size:128;not null;default:''"`
	AccessKeyID   string `gorm:"size:32;uniqueIndex;not null;column:access_key_id"`
	SecretKeyHash string `gorm:"size:512;not null;column:secret_key_hash"` // argon2id
	Status        string `gorm:"size:16;default:offline;check:status IN ('online','offline')"` // online | offline
	Description   string `gorm:"size:255;not null;default:''"`

	LastSeenAt *time.Time `gorm:"column:last_seen_at"`
	// AgentVersion is the binary semver the edge agent self-reported on
	// its most recent register_edge handshake (e.g. "0.7.43"). Empty
	// string for edges registered before the field was introduced or
	// agents that decline to report. Used by the SPA's Edges page so
	// operators can audit version drift across the fleet at a glance.
	AgentVersion string `gorm:"size:32;not null;default:'';column:agent_version"`
	// DeviceID is the convenience pointer to the host Device (the device
	// this edge is running on). Source of truth is the edge_devices
	// junction (Type=Host); this field is kept synchronised by the
	// register flow so old callers that read e.DeviceID don't break.
	DeviceID  *uint64        `gorm:"index;column:device_id"`
	// ShellUser is the OS user WebSSH logs in as on this host, self-reported
	// by the agent on register_edge (set at install via
	// ONGRID_EDGE_SHELL_USER). The webshell handler uses it as the SSH user
	// for keyless login. Empty for pre-keyless agents → handler falls back
	// to "root".
	ShellUser string         `gorm:"size:64;not null;default:'';column:shell_user"`
	CreatedBy *uint64        `gorm:"column:created_by"` // audit only
	CreatedAt time.Time      `gorm:"column:created_at"`
	UpdatedAt time.Time      `gorm:"column:updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index;column:deleted_at"` // soft delete
}

// TableName pins the SQLite table.
func (Edge) TableName() string { return "edges" }

// Status constants. MVP uses the binary online/offline; "disabled" is not
// used post-pivot — deletion is soft-delete via DeletedAt.
const (
	StatusOnline  = "online"
	StatusOffline = "offline"
)
