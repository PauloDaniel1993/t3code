## ADDED Requirements

### Requirement: Native Windows Kimi installs have a resolved update path

A native Windows installation of Kimi Code CLI SHALL have a documented, deliberate update path in
T3 Code, chosen from the candidates recorded in this change's design and implemented accordingly.
Until that decision is made, T3 Code SHALL continue to show the vendor's install script as a manual
command rather than offering a runnable action that cannot update the install.

#### Scenario: Decision is to run the vendor install script

- **WHEN** the recorded decision is to run the vendor install script under supervision
- **THEN** a native Windows install offers that command as a runnable update action, showing the
  exact command and requiring explicit confirmation before it runs

#### Scenario: Decision is to stay manual

- **WHEN** the recorded decision is to keep native Windows updates manual
- **THEN** a native Windows install shows the vendor install script as a copyable command and offers
  no runnable action

#### Scenario: Decision is pending

- **WHEN** no decision has been recorded
- **THEN** the current manual-command behavior is retained unchanged

#### Scenario: Other install sources are unaffected

- **WHEN** a Kimi install is package-managed, WinGet-managed, or a native macOS or Linux install
- **THEN** its existing update action is unchanged by this decision

### Requirement: A WinGet-managed Kimi install that is already current is not reported as a failure

T3 Code SHALL report the outcome as unchanged rather than as a command failure where a Kimi update
runs through WinGet and WinGet reports that no upgrade is available.

#### Scenario: WinGet has nothing to upgrade

- **WHEN** `winget upgrade` for the Kimi package exits with its "no available upgrade" status
- **THEN** the update outcome is reported as unchanged with that explanation, not as a failed
  command
