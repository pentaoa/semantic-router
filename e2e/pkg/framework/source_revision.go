package framework

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

const dashboardDockerfile = "dashboard/backend/Dockerfile"

var immutableSourceRevisionPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$`)

func localImageDockerBuildArgs(image LocalImageBuild) (map[string]string, error) {
	args := localDockerBuildArgs()
	if image.Dockerfile != dashboardDockerfile {
		return args, nil
	}
	revision, err := dashboardSourceRevision()
	if err != nil {
		return nil, err
	}
	args["VLLM_SR_SOURCE_REVISION"] = revision
	return args, nil
}

func dashboardSourceRevision() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("VLLM_SR_SOURCE_REVISION")); configured != "" {
		if !immutableSourceRevisionPattern.MatchString(configured) {
			return "", fmt.Errorf("VLLM_SR_SOURCE_REVISION must be a full Git commit or sha256 source-tree digest")
		}
		return configured, nil
	}
	rootOutput, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("resolve repository root before Dashboard E2E image build: %w", err)
	}
	root := strings.TrimSpace(string(rootOutput))
	resolver := exec.Command("python3", root+"/tools/ci/source-tree-revision.py")
	resolver.Dir = root
	revision, err := resolver.Output()
	if err != nil {
		return "", fmt.Errorf("resolve immutable Dashboard E2E source revision: %w", err)
	}
	resolved := strings.TrimSpace(string(revision))
	if !immutableSourceRevisionPattern.MatchString(resolved) {
		return "", fmt.Errorf("resolved Dashboard E2E source revision is not immutable")
	}
	return resolved, nil
}
