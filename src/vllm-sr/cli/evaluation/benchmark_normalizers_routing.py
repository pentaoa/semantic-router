"""Routing benchmark normalizer entry points."""

from cli.evaluation.benchmark_normalizer_coderouter import (
    normalize_coderouterbench,
)
from cli.evaluation.benchmark_normalizer_routerarena import (
    normalize_routerarena,
)

__all__ = ["normalize_coderouterbench", "normalize_routerarena"]
