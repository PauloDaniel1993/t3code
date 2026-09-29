# T3 Code fork

This fork tracks upstream T3 Code and carries its own features on top. These terms name how the fork relates to upstream; upstream's product vocabulary lives in `docs/internals/glossary.md`.

## Language

**Upstream**:
The pingdotgg/t3code project this fork follows, and its `main` branch in particular.
_Avoid_: Theo's version, origin

**Fork delta**:
Everything the fork carries on top of upstream `main`: its own features, migrations, branding, and local-install behavior.
_Avoid_: our changes, customizations

**V2 preview line**:
Upstream's unreleased line of development that preview releases are cut from, ahead of `main` and built on orchestration v2.
_Avoid_: V2 branch, Theo's version, preview branch

**Orchestration v2**:
The server engine inside the V2 preview line that replaces the V1 decider, projector, and reactors.
_Avoid_: V2 (unqualified)

**V2 integration**:
The effort to bring the V2 preview line into the fork with the fork delta ported onto it, carried on the `integrate/v2` branch.
_Avoid_: V2 merge, V2 migration
