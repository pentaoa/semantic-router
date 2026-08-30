package evaluationplane

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"
)

const lifecycleAuditDirectoryName = "audit"

var lifecycleAuditFilePattern = regexp.MustCompile(`^([0-9]{20})-([0-9a-f]{64})\.json$`)

type lifecycleCoordinator struct {
	mu         sync.Mutex
	loaded     bool
	sequence   uint64
	headDigest string
	bytes      int64
	records    map[string]lifecycleAuditRecord
}

var lifecycleCoordinators = struct {
	sync.Mutex
	byRoot map[string]*lifecycleCoordinator
}{byRoot: make(map[string]*lifecycleCoordinator)}

func sharedLifecycleCoordinator(root string) *lifecycleCoordinator {
	lifecycleCoordinators.Lock()
	defer lifecycleCoordinators.Unlock()
	if existing := lifecycleCoordinators.byRoot[root]; existing != nil {
		return existing
	}
	created := &lifecycleCoordinator{records: make(map[string]lifecycleAuditRecord)}
	lifecycleCoordinators.byRoot[root] = created
	return created
}

type lifecycleAuditRecord struct {
	SchemaVersion  string    `json:"schema_version"`
	Sequence       uint64    `json:"sequence"`
	Timestamp      time.Time `json:"timestamp"`
	Action         string    `json:"action"`
	Decision       string    `json:"decision"`
	ReasonCode     string    `json:"reason_code"`
	ActorDigest    string    `json:"actor_digest"`
	RunID          string    `json:"run_id,omitempty"`
	OwnerDigest    string    `json:"owner_digest,omitempty"`
	PreviousDigest string    `json:"previous_digest,omitempty"`
	Digest         string    `json:"digest"`
}

type lifecycleAuditWriter interface {
	WriteExclusive(path string, value any) error
}

type atomicLifecycleAuditWriter struct{}

func (atomicLifecycleAuditWriter) WriteExclusive(path string, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode lifecycle audit record: %w", err)
	}
	encoded = append(encoded, '\n')
	if int64(len(encoded)) > maxLifecycleRecordSize {
		return fmt.Errorf("lifecycle audit record exceeds its durable envelope")
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".tmp-lifecycle-audit-*")
	if err != nil {
		return fmt.Errorf("stage lifecycle audit record: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect lifecycle audit record: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write lifecycle audit record: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync lifecycle audit record: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close lifecycle audit record: %w", err)
	}
	if err := os.Link(temporaryPath, path); err != nil {
		return fmt.Errorf("publish lifecycle audit record: %w", err)
	}
	return syncEvaluationDirectory(filepath.Dir(path), "evaluation lifecycle audit")
}

func (s *Store) validateLifecycleAuditUnlocked() error {
	entries, err := os.ReadDir(s.lifecycleAuditRoot)
	if err != nil {
		return fmt.Errorf("list evaluation lifecycle audit: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	var sequence uint64
	var previous string
	var total int64
	records := make(map[string]lifecycleAuditRecord, len(entries))
	for _, entry := range entries {
		match := lifecycleAuditFilePattern.FindStringSubmatch(entry.Name())
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || match == nil {
			return fmt.Errorf("%w: lifecycle audit contains an invalid entry", ErrInvalid)
		}
		parsedSequence, parseErr := strconv.ParseUint(match[1], 10, 64)
		if parseErr != nil || parsedSequence != sequence+1 || parsedSequence > maxLifecycleAuditCount {
			return fmt.Errorf("%w: lifecycle audit sequence is invalid", ErrInvalid)
		}
		path := filepath.Join(s.lifecycleAuditRoot, entry.Name())
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 ||
			info.Size() > maxLifecycleRecordSize {
			return fmt.Errorf("%w: lifecycle audit record is not a private bounded file", ErrInvalid)
		}
		var record lifecycleAuditRecord
		if readErr := readJSON(path, &record); readErr != nil {
			return fmt.Errorf("%w: lifecycle audit record is unreadable: %w", ErrInvalid, readErr)
		}
		if record.Sequence != parsedSequence || record.PreviousDigest != previous ||
			match[2] != trimSHA256(record.Digest) || validateLifecycleAuditRecord(record) != nil {
			return fmt.Errorf("%w: lifecycle audit hash chain is invalid", ErrInvalid)
		}
		total += info.Size()
		if total > s.lifecyclePolicy.Limits.MaxAuditBytes {
			return fmt.Errorf("%w: lifecycle audit exceeds its configured bound", ErrInvalid)
		}
		sequence, previous = record.Sequence, record.Digest
		records[record.Digest] = record
	}
	s.lifecycle.sequence, s.lifecycle.headDigest, s.lifecycle.bytes = sequence, previous, total
	s.lifecycle.records, s.lifecycle.loaded = records, true
	return nil
}

func validateLifecycleAuditRecord(record lifecycleAuditRecord) error {
	if record.SchemaVersion != lifecycleAuditSchemaVersion || record.Sequence == 0 ||
		record.Timestamp.IsZero() || !validLifecycleAction(record.Action) ||
		(record.Decision != "allowed" && record.Decision != "denied") ||
		!validLifecycleReason(record.ReasonCode) || !digestPattern.MatchString(record.ActorDigest) ||
		(record.OwnerDigest != "" && !digestPattern.MatchString(record.OwnerDigest)) ||
		(record.RunID != "" && !validClientRequestID(record.RunID)) ||
		(record.PreviousDigest != "" && !digestPattern.MatchString(record.PreviousDigest)) ||
		record.Digest != lifecycleAuditDigest(record) {
		return fmt.Errorf("invalid lifecycle audit record")
	}
	return nil
}

func lifecycleAuditDigest(record lifecycleAuditRecord) string {
	record.Digest = ""
	encoded, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	return digestBytes(encoded)
}

func trimSHA256(digest string) string {
	if len(digest) == len("sha256:")+64 {
		return digest[len("sha256:"):]
	}
	return ""
}

func validLifecycleAction(action string) bool {
	switch action {
	case "create", "start", "cancel", "hold", "release", "retention", "delete", "gc":
		return true
	default:
		return false
	}
}

func validLifecycleReason(reason string) bool {
	switch reason {
	case "owner", "administrator", "system", "not_owner", "not_administrator", "not_found",
		"conflict", "invalid_request",
		"quota_owner_bytes", "quota_owner_runs", "quota_store_bytes", "evidence_hold",
		"protected_retention", "referenced", "dry_run", "apply", "delete_cascade", "startup_recovery":
		return true
	default:
		return false
	}
}

func (s *Store) appendLifecycleAuditUnlocked(
	actor Actor,
	action, decision, reasonCode, runID, ownerDigest string,
) (lifecycleAuditRecord, error) {
	if err := validateActor(actor); err != nil {
		return lifecycleAuditRecord{}, err
	}
	if !s.lifecycle.loaded {
		return lifecycleAuditRecord{}, fmt.Errorf("evaluation lifecycle audit is not initialized")
	}
	if s.lifecycle.sequence >= maxLifecycleAuditCount {
		return lifecycleAuditRecord{}, fmt.Errorf("%w: lifecycle audit record bound reached", ErrQuota)
	}
	now := s.lifecycleNow().UTC().Truncate(time.Microsecond)
	record := lifecycleAuditRecord{
		SchemaVersion: lifecycleAuditSchemaVersion, Sequence: s.lifecycle.sequence + 1,
		Timestamp: now, Action: action, Decision: decision, ReasonCode: reasonCode,
		ActorDigest: actor.principalDigest, RunID: runID, OwnerDigest: ownerDigest,
		PreviousDigest: s.lifecycle.headDigest,
	}
	record.Digest = lifecycleAuditDigest(record)
	if err := validateLifecycleAuditRecord(record); err != nil {
		return lifecycleAuditRecord{}, fmt.Errorf("encode lifecycle audit decision: %w", err)
	}
	name := fmt.Sprintf("%020d-%s.json", record.Sequence, trimSHA256(record.Digest))
	encoded, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return lifecycleAuditRecord{}, err
	}
	projected := s.lifecycle.bytes + int64(len(encoded)+1)
	if projected > s.lifecyclePolicy.Limits.MaxAuditBytes {
		return lifecycleAuditRecord{}, fmt.Errorf("%w: lifecycle audit byte bound reached", ErrQuota)
	}
	if err := s.lifecycleAuditWriter.WriteExclusive(filepath.Join(s.lifecycleAuditRoot, name), record); err != nil {
		return lifecycleAuditRecord{}, err
	}
	s.lifecycle.sequence, s.lifecycle.headDigest, s.lifecycle.bytes = record.Sequence, record.Digest, projected
	s.lifecycle.records[record.Digest] = record
	return record, nil
}
