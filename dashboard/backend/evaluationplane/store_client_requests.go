package evaluationplane

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

const (
	maxClientRequestIndexBytes           = int64(4 * 1024)
	clientRequestMigrationMarkerFileName = "client-request-index-v1.complete.json"
)

type clientRequestIndexEntry struct {
	SchemaVersion   string `json:"schema_version"`
	ClientRequestID string `json:"client_request_id"`
	RunID           string `json:"run_id"`
	RequestDigest   string `json:"request_digest"`
}

type clientRequestMigrationMarker struct {
	SchemaVersion string `json:"schema_version"`
	Kind          string `json:"kind"`
}

func (s *Store) HydrateLegacyClientRequestIndices() error {
	complete, err := s.clientRequestMigrationComplete()
	if err != nil {
		return fmt.Errorf("%w: client request index migration marker is invalid", ErrConflict)
	}
	if complete {
		return nil
	}
	entries, err := os.ReadDir(s.runsRoot)
	if err != nil {
		return fmt.Errorf("read legacy evaluation runs for client request migration: %w", err)
	}
	for _, directory := range entries {
		if !directory.IsDir() || !safeIDPattern.MatchString(directory.Name()) {
			continue
		}
		run, readErr := s.GetRun(directory.Name())
		if readErr != nil {
			return fmt.Errorf(
				"%w: client request index migration cannot classify legacy run %s",
				ErrConflict,
				directory.Name(),
			)
		}
		if run.ClientRequestID == "" {
			continue
		}
		requestDigest, digestErr := createRequestDigest(createRequestFromRun(run))
		if digestErr != nil {
			return digestErr
		}
		desired := clientRequestIndexEntry{
			SchemaVersion: SchemaVersion, ClientRequestID: run.ClientRequestID,
			RunID: run.ID, RequestDigest: requestDigest,
		}
		indexed, created, reserveErr := s.ReserveClientRequestIndex(desired)
		if reserveErr != nil {
			return fmt.Errorf("%w: client request index migration could not reserve legacy key", ErrConflict)
		}
		if !created && indexed != desired {
			return fmt.Errorf("%w: ambiguous legacy client_request_id %s", ErrConflict, run.ClientRequestID)
		}
	}
	if markerErr := s.publishClientRequestMigrationMarker(); markerErr != nil {
		return markerErr
	}
	return nil
}

func (s *Store) clientRequestMigrationMarkerPath() string {
	return filepath.Join(s.root, "index", clientRequestMigrationMarkerFileName)
}

func (s *Store) clientRequestMigrationComplete() (bool, error) {
	path := s.clientRequestMigrationMarkerPath()
	data, err := readEvidenceBytes(path, maxClientRequestIndexBytes)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var marker clientRequestMigrationMarker
	if decodeErr := decoder.Decode(&marker); decodeErr != nil {
		return false, decodeErr
	}
	if eofErr := ensureJSONEOF(decoder); eofErr != nil {
		return false, eofErr
	}
	if marker.SchemaVersion != SchemaVersion || marker.Kind != "client-request-index-v1" {
		return false, fmt.Errorf("client request index migration marker identity is invalid")
	}
	return true, nil
}

func (s *Store) publishClientRequestMigrationMarker() error {
	created, err := writeJSONExclusiveAtomic(
		s.clientRequestMigrationMarkerPath(),
		clientRequestMigrationMarker{SchemaVersion: SchemaVersion, Kind: "client-request-index-v1"},
	)
	if err != nil {
		return fmt.Errorf("publish client request index migration marker: %w", err)
	}
	if created {
		return nil
	}
	complete, err := s.clientRequestMigrationComplete()
	if err != nil || !complete {
		return fmt.Errorf("%w: client request index migration marker is unavailable", ErrConflict)
	}
	return nil
}

func (s *Store) clientRequestIndexPath(clientRequestID string) (string, error) {
	parsed, err := uuid.Parse(clientRequestID)
	if err != nil || parsed.String() != clientRequestID {
		return "", fmt.Errorf("%w: client_request_id must be a canonical UUID", ErrInvalid)
	}
	indexRoot := filepath.Join(s.root, "index")
	if privateDirectoryErr := requirePrivateDirectory(indexRoot); privateDirectoryErr != nil {
		return "", privateDirectoryErr
	}
	return filepath.Join(indexRoot, "client-request-"+clientRequestID+".json"), nil
}

func (s *Store) ClientRequestIndex(clientRequestID string) (clientRequestIndexEntry, bool, error) {
	path, err := s.clientRequestIndexPath(clientRequestID)
	if err != nil {
		return clientRequestIndexEntry{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return readClientRequestIndex(path, clientRequestID)
}

// ReconcileClientRequestIndex repairs an anomalously missing per-key index from
// the durable run bundles. The migration marker proves that the initial scan
// completed, but it cannot prove that an individual index file was not later
// lost. A missing key therefore needs this targeted, fail-closed reconciliation
// before CreateRun may reserve a fresh run identity.
func (s *Store) ReconcileClientRequestIndex(
	clientRequestID string,
) (clientRequestIndexEntry, bool, error) {
	if _, err := s.clientRequestIndexPath(clientRequestID); err != nil {
		return clientRequestIndexEntry{}, false, err
	}
	entries, err := os.ReadDir(s.runsRoot)
	if err != nil {
		return clientRequestIndexEntry{}, false, fmt.Errorf("read evaluation runs for client request reconciliation: %w", err)
	}

	var desired *clientRequestIndexEntry
	for _, directory := range entries {
		if !directory.IsDir() || !safeIDPattern.MatchString(directory.Name()) {
			continue
		}
		run, readErr := s.GetRun(directory.Name())
		if readErr != nil {
			return clientRequestIndexEntry{}, false, fmt.Errorf(
				"%w: client request index reconciliation cannot classify run %s",
				ErrConflict,
				directory.Name(),
			)
		}
		if run.ClientRequestID != clientRequestID {
			continue
		}
		requestDigest, digestErr := createRequestDigest(createRequestFromRun(run))
		if digestErr != nil {
			return clientRequestIndexEntry{}, false, digestErr
		}
		candidate := clientRequestIndexEntry{
			SchemaVersion: SchemaVersion, ClientRequestID: run.ClientRequestID,
			RunID: run.ID, RequestDigest: requestDigest,
		}
		if desired != nil && *desired != candidate {
			return clientRequestIndexEntry{}, false, fmt.Errorf(
				"%w: ambiguous durable client_request_id %s",
				ErrConflict,
				clientRequestID,
			)
		}
		desired = &candidate
	}
	if desired == nil {
		return clientRequestIndexEntry{}, false, nil
	}

	indexed, created, reserveErr := s.ReserveClientRequestIndex(*desired)
	if reserveErr != nil {
		return clientRequestIndexEntry{}, false, fmt.Errorf(
			"%w: client request index reconciliation could not reserve durable key",
			ErrConflict,
		)
	}
	if !created && indexed != *desired {
		return clientRequestIndexEntry{}, false, fmt.Errorf(
			"%w: client request index reconciliation found an ambiguous reservation",
			ErrConflict,
		)
	}
	return indexed, true, nil
}

func (s *Store) ReserveClientRequestIndex(
	entry clientRequestIndexEntry,
) (clientRequestIndexEntry, bool, error) {
	path, err := s.clientRequestIndexPath(entry.ClientRequestID)
	if err != nil {
		return clientRequestIndexEntry{}, false, err
	}
	if validationErr := validateClientRequestIndex(entry, entry.ClientRequestID); validationErr != nil {
		return clientRequestIndexEntry{}, false, validationErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	existing, found, err := readClientRequestIndex(path, entry.ClientRequestID)
	if err != nil || found {
		return existing, false, err
	}
	created, err := writeJSONExclusiveAtomic(path, entry)
	if err != nil {
		return clientRequestIndexEntry{}, false, err
	}
	if created {
		return entry, true, nil
	}
	// Another Store instance may have published the same key after our lookup.
	// Resolve that immutable winner instead of ever replacing it.
	existing, found, err = readClientRequestIndex(path, entry.ClientRequestID)
	if err != nil {
		return clientRequestIndexEntry{}, false, err
	}
	if !found {
		return clientRequestIndexEntry{}, false, fmt.Errorf("client request index disappeared during reservation")
	}
	return existing, false, nil
}

func readClientRequestIndex(
	path string,
	clientRequestID string,
) (clientRequestIndexEntry, bool, error) {
	data, err := readEvidenceBytes(path, maxClientRequestIndexBytes)
	if err != nil {
		if os.IsNotExist(err) {
			return clientRequestIndexEntry{}, false, nil
		}
		return clientRequestIndexEntry{}, false, fmt.Errorf("read client request index: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var entry clientRequestIndexEntry
	if decodeErr := decoder.Decode(&entry); decodeErr != nil {
		return clientRequestIndexEntry{}, false, fmt.Errorf("decode client request index: %w", decodeErr)
	}
	if eofErr := ensureJSONEOF(decoder); eofErr != nil {
		return clientRequestIndexEntry{}, false, eofErr
	}
	if validationErr := validateClientRequestIndex(entry, clientRequestID); validationErr != nil {
		return clientRequestIndexEntry{}, false, validationErr
	}
	return entry, true, nil
}

func validateClientRequestIndex(entry clientRequestIndexEntry, clientRequestID string) error {
	if entry.SchemaVersion != SchemaVersion || entry.ClientRequestID != clientRequestID {
		return fmt.Errorf("client request index identity is invalid")
	}
	if resourceIDErr := validateResourceID(entry.RunID); resourceIDErr != nil {
		return fmt.Errorf("client request index run identity is invalid: %w", resourceIDErr)
	}
	if !digestPattern.MatchString(entry.RequestDigest) {
		return fmt.Errorf("client request index digest is invalid")
	}
	return nil
}

// writeJSONExclusiveAtomic publishes a fully written, synced file without ever
// replacing an existing path. The hard-link publication is the create-only
// equivalent of an atomic rename and lets independent Store instances agree on
// one durable client-request reservation.
func writeJSONExclusiveAtomic(path string, value any) (bool, error) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return false, fmt.Errorf("encode evaluation index: %w", err)
	}
	encoded = append(encoded, '\n')
	directory := filepath.Dir(path)
	if privateDirectoryErr := requirePrivateDirectory(directory); privateDirectoryErr != nil {
		return false, privateDirectoryErr
	}
	temporary, err := os.CreateTemp(directory, ".tmp-evaluation-index-*")
	if err != nil {
		return false, fmt.Errorf("stage evaluation index: %w", err)
	}
	temporaryName := temporary.Name()
	defer func() { _ = os.Remove(temporaryName) }()
	if chmodErr := temporary.Chmod(0o600); chmodErr != nil {
		_ = temporary.Close()
		return false, fmt.Errorf("protect staged evaluation index: %w", chmodErr)
	}
	if _, writeErr := temporary.Write(encoded); writeErr != nil {
		_ = temporary.Close()
		return false, fmt.Errorf("write staged evaluation index: %w", writeErr)
	}
	if syncTemporaryErr := temporary.Sync(); syncTemporaryErr != nil {
		_ = temporary.Close()
		return false, fmt.Errorf("sync staged evaluation index: %w", syncTemporaryErr)
	}
	if closeTemporaryErr := temporary.Close(); closeTemporaryErr != nil {
		return false, fmt.Errorf("close staged evaluation index: %w", closeTemporaryErr)
	}
	if linkErr := os.Link(temporaryName, path); linkErr != nil {
		if os.IsExist(linkErr) {
			return false, nil
		}
		return false, fmt.Errorf("publish evaluation index: %w", linkErr)
	}
	directoryFile, err := os.Open(directory)
	if err != nil {
		return false, fmt.Errorf("open evaluation index directory: %w", err)
	}
	syncErr := directoryFile.Sync()
	closeErr := directoryFile.Close()
	if syncErr != nil {
		return false, fmt.Errorf("sync evaluation index directory: %w", syncErr)
	}
	if closeErr != nil {
		return false, fmt.Errorf("close evaluation index directory: %w", closeErr)
	}
	return true, nil
}
