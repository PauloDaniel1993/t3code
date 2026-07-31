## ADDED Requirements

### Requirement: A completed update reports its outcome on the provider card

The provider card SHALL render the outcome of a completed update — succeeded, unchanged, or failed —
together with the recorded message, for the provider instance the update ran on. An update that
completes without changing the detected version SHALL NOT return the card to its prior state with
no explanation.

#### Scenario: Update completes without changing the version

- **WHEN** an update command exits successfully but the provider version is still behind
- **THEN** the card reports that the update ran without changing the installed version, showing the
  recorded message

#### Scenario: Update fails

- **WHEN** an update command exits non-zero or times out
- **THEN** the card reports the failure and its recorded message

#### Scenario: Update succeeds

- **WHEN** an update command completes and the provider version is no longer behind
- **THEN** the card reports success and shows the updated version

#### Scenario: Update is still running

- **WHEN** an update is queued or running
- **THEN** the card reflects that state rather than offering the action again

#### Scenario: Outcome applies to one instance

- **WHEN** an update runs for one provider instance and other instances share the same driver
- **THEN** only the instance the update ran on reports the outcome

### Requirement: Captured update output is available for an unchanged or failed update

Where an update outcome is `unchanged` or `failed`, the card SHALL make the update command's
captured output available to the user, since that output frequently states the actual reason.

#### Scenario: Command explains its own refusal

- **WHEN** an update command exits zero and its output states that it did not update
- **THEN** that output is available to the user from the card

#### Scenario: Command produced no output

- **WHEN** an update finishes as unchanged or failed with no captured output
- **THEN** the card shows the recorded message alone without an empty output surface

### Requirement: T3 Code does not offer an update action that cannot update the executable in use

A provider SHALL offer a runnable update action only where that command updates the executable the
provider actually resolves to. Where no such command exists, the provider SHALL offer a manual
command instead of a runnable action.

#### Scenario: Updater refuses to act on this install source

- **WHEN** a provider's self-update command is known to exit successfully without updating for a
  given install source and platform
- **THEN** no runnable update action is offered for that install source, and a manual command is
  shown instead

#### Scenario: Update would write to a different location than the resolved executable

- **WHEN** the available update command would install to a location other than the one the
  provider's command resolves to
- **THEN** no runnable update action is offered for that install

### Requirement: Competing installations are surfaced, not resolved

T3 Code SHALL report which installation is in use, and that another exists, where a provider's
command resolves to one installation while another installation of the same provider is present.
T3 Code SHALL NOT delete, relocate, or reorder installations or modify the user's PATH.

#### Scenario: Two installations are present

- **WHEN** a provider resolves to one installation and a second installation of the same provider is
  detected
- **THEN** the card reports which one is in use and that another was found

#### Scenario: Only one installation is present

- **WHEN** exactly one installation is detected
- **THEN** no competing-installation notice is shown
