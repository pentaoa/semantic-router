package evaluationplane

// normalizedAdapterContract mirrors the immutable source and workload identity
// in the Python benchmark registry. These pins authenticate which parser and
// schema were selected; they do not attest that upstream benchmark code
// generated a submitted export.
type normalizedAdapterContract struct {
	sourceRevision  string
	datasetRevision string
	decisionUnit    string
	actionSpace     string
	trackIDs        []TrackID
}

var normalizedAdapterContracts = map[string]normalizedAdapterContract{
	"routerarena": {
		sourceRevision: "fda4c53bcf9a979fd9c6f6bb6b713d6ab08ff43e",
		decisionUnit:   "query", actionSpace: "one model",
		trackIDs: []TrackID{"routing", "model_pool", "joint"},
	},
	"coderouterbench": {
		sourceRevision:  "e43839edb0d5d0a9feec2f7078019406ab4d64bd",
		datasetRevision: "e567d89bdd569c9c74ffc7c7118e50d15e46b886",
		decisionUnit:    "stream item with verified-history state", actionSpace: "one coding backend",
		trackIDs: []TrackID{"routing", "model_pool", "joint"},
	},
	"llmrouterbench": {
		sourceRevision: "c77cb0506949d8f959e97967d2fefca0e8ff1b05",
		decisionUnit:   "query", actionSpace: "one model",
		trackIDs: []TrackID{"model_pool"},
	},
	"routerbench": {
		sourceRevision: "cc67d1008bd8f3cf1e8040cc3ba4034d31b93c0c",
		decisionUnit:   "query", actionSpace: "model, cascade, or over-generation policy",
		trackIDs: []TrackID{"model_pool"},
	},
	"xroutebench": {
		sourceRevision:  "da3430baaea672743c3957457b0c76faba19876e",
		datasetRevision: "ea4b6e1b29d9a734f55f0a637baf326bad6aa681",
		decisionUnit:    "single turn, session turn, or personalized state", actionSpace: "one model",
		trackIDs: []TrackID{"model_pool"},
	},
	"twinrouterbench": {
		sourceRevision: "7cbb0deac8f697b5faa8489c309560e53d2ef088",
		decisionUnit:   "agent trajectory prefix or step", actionSpace: "model tier",
		trackIDs: []TrackID{"agentic"},
	},
	"mmr-bench": {
		sourceRevision: "83c8308427a3597213fdba298c098da887b8b01b",
		decisionUnit:   "multimodal query", actionSpace: "one multimodal model",
		trackIDs: []TrackID{"model_pool", "multimodal"},
	},
	"acebench": {
		sourceRevision: "9a17bc2c7ee3fab9ca023036b82a81898512a001",
		decisionUnit:   "agent task or step with workspace and privacy state", actionSpace: "edge/cloud assistance policy",
		trackIDs: []TrackID{"agentic"},
	},
	"continuity-bench": {
		sourceRevision: "5b7e7f82027c5b983435057ddc4d7115b7e9a97b",
		decisionUnit:   "session failover event", actionSpace: "stateless fallback or history forwarding",
		trackIDs: []TrackID{"agentic"},
	},
	"fusionfactory": {
		sourceRevision: "ef62645a48b9e2167201047da047854415e2bc89",
		decisionUnit:   "query or reasoning thought", actionSpace: "model subset, topology, and synthesis policy",
		trackIDs: []TrackID{"model_pool"},
	},
	"r2-router": {
		sourceRevision: "b0b2291aeee08feb4bedbd199ab014ec60d0004f",
		decisionUnit:   "query plus budget condition", actionSpace: "model and output-token budget",
		trackIDs: []TrackID{"model_pool"},
	},
}

func normalizedAdapterTracksMatch(contract normalizedAdapterContract, trackIDs []TrackID) bool {
	allowed := make(map[TrackID]struct{}, len(contract.trackIDs))
	for _, trackID := range contract.trackIDs {
		allowed[trackID] = struct{}{}
	}
	for _, trackID := range trackIDs {
		if _, supported := allowed[trackID]; !supported {
			return false
		}
	}
	return len(trackIDs) > 0
}
