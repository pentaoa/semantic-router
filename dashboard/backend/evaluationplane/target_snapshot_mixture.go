package evaluationplane

import (
	"fmt"
	"sort"
	"strings"

	routerconfig "github.com/vllm-project/semantic-router/src/semantic-router/pkg/config"
)

type mixtureModelInventory struct {
	poolModels     map[string]struct{}
	decisionModels [][]string
	supportModels  map[string]struct{}
	fallbackModel  string
}

func mixtureSnapshotsFromConfig(
	cfg *routerconfig.RouterConfig,
	canonical routerconfig.CanonicalConfig,
	runtimeRevision string,
) ([]MixtureTargetSnapshot, error) {
	if cfg == nil {
		return nil, nil
	}
	armsByModel := modelArmsByName(canonical, runtimeRevision)
	aliasesByRecipe, recipeOrder := recipeEntrypointAliases(cfg)
	mixtures := make([]MixtureTargetSnapshot, 0, len(recipeOrder))
	for _, recipeName := range recipeOrder {
		recipe, err := configuredRecipe(cfg, recipeName)
		if err != nil {
			return nil, err
		}
		aliases := append([]string(nil), aliasesByRecipe[recipeName]...)
		entrypoint := preferredRecipeEntrypoint(cfg, recipeName, aliases)
		mixtures = append(mixtures, mixtureSnapshotForRecipe(
			cfg, canonical, recipe, entrypoint, aliases, armsByModel,
		))
	}
	if len(mixtures) == 0 {
		return nil, nil
	}
	return mixtures, nil
}

func modelArmsByName(
	canonical routerconfig.CanonicalConfig,
	runtimeRevision string,
) map[string]ModelArm {
	allArms := modelArmsFromCanonical(canonical, runtimeRevision)
	armsByModel := make(map[string]ModelArm, len(allArms))
	for _, arm := range allArms {
		armsByModel[arm.Model] = arm
	}
	return armsByModel
}

func recipeEntrypointAliases(
	cfg *routerconfig.RouterConfig,
) (map[routerconfig.RecipeName][]string, []routerconfig.RecipeName) {
	aliasesByRecipe := make(map[routerconfig.RecipeName][]string)
	recipeOrder := make([]routerconfig.RecipeName, 0, len(cfg.Entrypoints)+1)
	addAliases := func(recipe routerconfig.RecipeName, aliases []string) {
		if len(aliases) == 0 {
			return
		}
		if _, exists := aliasesByRecipe[recipe]; !exists {
			recipeOrder = append(recipeOrder, recipe)
		}
		aliasesByRecipe[recipe] = appendUniqueStrings(aliasesByRecipe[recipe], aliases...)
	}
	addAliases(routerconfig.DefaultRecipeName, cfg.EffectiveAutoModelNames())
	for _, entrypoint := range cfg.Entrypoints {
		addAliases(entrypoint.Recipe, entrypoint.ModelNames)
	}
	return aliasesByRecipe, recipeOrder
}

func configuredRecipe(
	cfg *routerconfig.RouterConfig,
	recipeName routerconfig.RecipeName,
) (*routerconfig.RoutingRecipe, error) {
	recipe, ok := cfg.RecipeByName(recipeName)
	if !ok && recipeName == routerconfig.DefaultRecipeName {
		recipe = cfg.DefaultRecipe()
		ok = recipe != nil
	}
	if !ok {
		return nil, fmt.Errorf("build evaluation mixture: recipe %q is unavailable", recipeName)
	}
	return recipe, nil
}

func preferredRecipeEntrypoint(
	cfg *routerconfig.RouterConfig,
	recipeName routerconfig.RecipeName,
	aliases []string,
) string {
	entrypoint := aliases[0]
	if recipeName != routerconfig.DefaultRecipeName {
		return entrypoint
	}
	preferred := cfg.GetEffectiveAutoModelName()
	if containsString(aliases, preferred) {
		return preferred
	}
	return entrypoint
}

func mixtureSnapshotForRecipe(
	cfg *routerconfig.RouterConfig,
	canonical routerconfig.CanonicalConfig,
	recipe *routerconfig.RoutingRecipe,
	entrypoint string,
	aliases []string,
	armsByModel map[string]ModelArm,
) MixtureTargetSnapshot {
	scopedRouting := routerconfig.CanonicalConfigFromRouterConfig(cfg.ConfigForRecipe(recipe)).Routing
	inventory := collectMixtureModelInventory(canonical, recipe)
	poolArms, armIDByModel, armsReady := resolveMixtureArms(inventory.poolModels, armsByModel)
	supportModels, supportReady := resolveMixtureSupportModels(
		canonical, scopedRouting, inventory, armsByModel,
	)
	decisions, decisionsReady := resolveMixtureDecisions(recipe, inventory.decisionModels, armIDByModel)
	ready := strings.TrimSpace(entrypoint) != "" && len(inventory.poolModels) > 0 &&
		armsReady && supportReady && decisionsReady

	mixtureID := mixtureTargetID(recipe.Name)
	fallbackArmID := armIDByModel[inventory.fallbackModel]
	selectorPolicyDigest := selectorPolicySnapshotDigest(scopedRouting)
	mixture := ManifestMixture{
		SchemaVersion: SchemaVersion, ID: mixtureID,
		EntrypointModel: entrypoint, Aliases: append([]string(nil), aliases...),
		RecipeName: string(recipe.Name), RecipeDescription: strings.TrimSpace(recipe.Description),
		RecipeDigest: recipeSnapshotDigest(cfg, recipe), PoolDigest: modelPoolSnapshotDigest(poolArms),
		SelectorPolicyDigest: selectorPolicyDigest,
		SelectorDigest:       selectorSnapshotDigest(selectorPolicyDigest, supportModels),
		AdaptationDigest:     adaptationSnapshotDigest(scopedRouting),
		BindingDigest: mixtureBindingSnapshotDigest(
			mixtureID, entrypoint, aliases, recipe, fallbackArmID,
		),
		ModelArms: copyModelArms(poolArms), SupportModels: supportModels,
		FallbackArmID: fallbackArmID, Decisions: decisions,
	}
	topologyDigest := backendTopologyDigestForModels(canonical, inventory.poolModels)
	if !digestPattern.MatchString(topologyDigest) {
		ready = false
	}
	return MixtureTargetSnapshot{Mixture: mixture, BackendTopologyDigest: topologyDigest, Ready: ready}
}

func collectMixtureModelInventory(
	canonical routerconfig.CanonicalConfig,
	recipe *routerconfig.RoutingRecipe,
) mixtureModelInventory {
	inventory := mixtureModelInventory{
		poolModels:     make(map[string]struct{}),
		decisionModels: make([][]string, len(recipe.Profile.Decisions)),
		supportModels:  make(map[string]struct{}),
		fallbackModel:  strings.TrimSpace(canonical.Providers.Defaults.DefaultModel),
	}
	for index, decision := range recipe.Profile.Decisions {
		for _, ref := range decision.ModelRefs {
			addMixtureModel(inventory.poolModels, &inventory.decisionModels[index], ref.Model)
		}
		for _, iteration := range decision.CandidateIterations {
			if strings.TrimSpace(iteration.Source) != "models" {
				continue
			}
			for _, ref := range iteration.Models {
				addMixtureModel(inventory.poolModels, &inventory.decisionModels[index], ref.Model)
			}
		}
	}
	if inventory.fallbackModel != "" {
		inventory.poolModels[inventory.fallbackModel] = struct{}{}
		for index, decision := range recipe.Profile.Decisions {
			if len(decision.ModelRefs) == 0 {
				inventory.decisionModels[index] = []string{inventory.fallbackModel}
			}
		}
	}
	for _, decision := range recipe.Profile.Decisions {
		if decision.Algorithm == nil || decision.Algorithm.Prompt == nil {
			continue
		}
		model := strings.TrimSpace(decision.Algorithm.Prompt.Model)
		if _, candidate := inventory.poolModels[model]; model != "" && !candidate {
			inventory.supportModels[model] = struct{}{}
		}
	}
	return inventory
}

func resolveMixtureArms(
	poolModels map[string]struct{},
	armsByModel map[string]ModelArm,
) ([]ModelArm, map[string]string, bool) {
	ready := true
	poolArms := make([]ModelArm, 0, len(poolModels))
	armIDByModel := make(map[string]string, len(poolModels))
	for model := range poolModels {
		arm, ok := armsByModel[model]
		if !ok {
			ready = false
			continue
		}
		poolArms = append(poolArms, arm)
		armIDByModel[model] = arm.ID
	}
	sort.Slice(poolArms, func(i, j int) bool { return poolArms[i].Model < poolArms[j].Model })
	return poolArms, armIDByModel, ready
}

func resolveMixtureSupportModels(
	canonical routerconfig.CanonicalConfig,
	routing routerconfig.CanonicalRouting,
	inventory mixtureModelInventory,
	armsByModel map[string]ModelArm,
) ([]SupportModel, bool) {
	ready := true
	supportByName := make(map[string]SupportModel, len(inventory.supportModels)+len(routing.Signals.Classifiers))
	for model := range inventory.supportModels {
		arm, ok := armsByModel[model]
		topologyDigest := backendTopologyDigestForModels(canonical, map[string]struct{}{model: {}})
		if !ok || arm.ConfigDigest == nil || !digestPattern.MatchString(topologyDigest) {
			ready = false
			continue
		}
		supportByName[model] = SupportModel{
			Model: arm.Model, ProviderModelIDDigest: arm.ProviderModelIDDigest,
			ConfigDigest: *arm.ConfigDigest, RuntimeRevision: copyStringPointer(arm.RuntimeRevision),
			BackendTopologyDigest: topologyDigest,
		}
	}
	externalModels := externalModelsByName(canonical)
	for _, classifier := range routing.Signals.Classifiers {
		if strings.TrimSpace(classifier.Type) != "llm" {
			continue
		}
		modelName := strings.TrimSpace(classifier.Model)
		external, exists := externalModels[modelName]
		support, valid := externalSelectorSupportModel(external)
		_, candidate := inventory.poolModels[modelName]
		prior, duplicate := supportByName[modelName]
		if !exists || !valid || candidate || (duplicate && prior != support) {
			ready = false
			continue
		}
		supportByName[modelName] = support
	}
	result := make([]SupportModel, 0, len(supportByName))
	for _, support := range supportByName {
		result = append(result, support)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Model < result[j].Model })
	return result, ready
}

func externalModelsByName(
	canonical routerconfig.CanonicalConfig,
) map[string]routerconfig.ExternalModelConfig {
	result := map[string]routerconfig.ExternalModelConfig{}
	if canonical.Global == nil {
		return result
	}
	for _, external := range canonical.Global.ModelCatalog.External {
		result[strings.TrimSpace(external.Name)] = external
	}
	return result
}

func resolveMixtureDecisions(
	recipe *routerconfig.RoutingRecipe,
	decisionModels [][]string,
	armIDByModel map[string]string,
) ([]MixtureDecisionBinding, bool) {
	ready := true
	result := make([]MixtureDecisionBinding, 0, len(recipe.Profile.Decisions))
	for index, decision := range recipe.Profile.Decisions {
		armIDs := make([]string, 0, len(decisionModels[index]))
		for _, model := range decisionModels[index] {
			armID, ok := armIDByModel[model]
			if !ok {
				ready = false
				continue
			}
			armIDs = append(armIDs, armID)
		}
		sort.Strings(armIDs)
		if len(armIDs) == 0 {
			ready = false
			continue
		}
		result = append(result, MixtureDecisionBinding{
			Name: strings.TrimSpace(decision.Name), Algorithm: decisionAlgorithmName(decision), ArmIDs: armIDs,
		})
	}
	return result, ready
}

func addMixtureModel(pool map[string]struct{}, decisionModels *[]string, raw string) {
	model := strings.TrimSpace(raw)
	if model == "" {
		return
	}
	pool[model] = struct{}{}
	if !containsString(*decisionModels, model) {
		*decisionModels = append(*decisionModels, model)
	}
}

func decisionAlgorithmName(decision routerconfig.Decision) string {
	if len(decision.ModelRefs) == 0 {
		return "default"
	}
	if decision.GetFastResponseConfig() != nil {
		return "fast_response"
	}
	if len(decision.ModelRefs) == 1 {
		return "single"
	}
	if decision.Algorithm == nil {
		return "static"
	}
	methods := map[string]string{
		"router_dc": "router_dc", "automix": "automix", "hybrid": "hybrid",
		"latency_aware": "latency_aware", "static": "static", "knn": "knn",
		"kmeans": "kmeans", "svm": "svm", "multi_factor": "multi_factor",
		"mlp": "mlp", "prompt": "prompt",
	}
	if method, ok := methods[decision.Algorithm.Type]; ok {
		return method
	}
	return "static"
}

func recipeSnapshotDigest(cfg *routerconfig.RouterConfig, recipe *routerconfig.RoutingRecipe) string {
	canonical := routerconfig.CanonicalConfigFromRouterConfig(cfg.ConfigForRecipe(recipe))
	return digestJSON(policyRecipeFingerprint{
		Name: string(recipe.Name), Routing: policyRoutingFromCanonical(canonical.Routing),
	})
}

func mixtureTargetID(recipe routerconfig.RecipeName) string {
	return "mom-" + strings.TrimPrefix(digestString(string(recipe)), "sha256:")
}

func modelPoolSnapshotDigest(arms []ModelArm) string {
	return digestJSON(struct {
		ModelArms []ModelArm `json:"model_arms"`
	}{ModelArms: arms})
}

func selectorSnapshotDigest(policyDigest string, models []SupportModel) string {
	return digestJSON(struct {
		PolicyDigest  string         `json:"policy_digest"`
		SupportModels []SupportModel `json:"support_models"`
	}{PolicyDigest: policyDigest, SupportModels: models})
}

type candidateModelBindingFingerprint struct {
	Models []routerconfig.ModelRef `json:"models,omitempty"`
}

type decisionModelBindingFingerprint struct {
	ModelRefs           []routerconfig.ModelRef            `json:"model_refs,omitempty"`
	CandidateIterations []candidateModelBindingFingerprint `json:"candidate_iterations,omitempty"`
}

func mixtureBindingSnapshotDigest(
	mixtureID, entrypoint string,
	aliases []string,
	recipe *routerconfig.RoutingRecipe,
	fallbackArmID string,
) string {
	decisions := make([]decisionModelBindingFingerprint, 0, len(recipe.Profile.Decisions))
	for _, decision := range recipe.Profile.Decisions {
		iterations := make([]candidateModelBindingFingerprint, 0, len(decision.CandidateIterations))
		for _, iteration := range decision.CandidateIterations {
			if strings.TrimSpace(iteration.Source) != "models" {
				continue
			}
			iterations = append(iterations, candidateModelBindingFingerprint{
				Models: append([]routerconfig.ModelRef(nil), iteration.Models...),
			})
		}
		decisions = append(decisions, decisionModelBindingFingerprint{
			ModelRefs:           append([]routerconfig.ModelRef(nil), decision.ModelRefs...),
			CandidateIterations: iterations,
		})
	}
	return digestJSON(struct {
		MixtureID   string                            `json:"mixture_id"`
		Entrypoint  string                            `json:"entrypoint_model"`
		Aliases     []string                          `json:"aliases"`
		RecipeName  string                            `json:"recipe_name"`
		FallbackArm string                            `json:"fallback_arm_id,omitempty"`
		Decisions   []decisionModelBindingFingerprint `json:"decisions"`
	}{
		MixtureID: mixtureID, Entrypoint: entrypoint, Aliases: aliases,
		RecipeName: string(recipe.Name), FallbackArm: fallbackArmID, Decisions: decisions,
	})
}
