## 1. Protocol parsing

- [ ] 1.1 Add an `AvailableCommandsChanged` variant to `AcpParsedSessionEvent` in
      `apps/server/src/provider/acp/AcpRuntimeModel.ts`
- [ ] 1.2 Parse `sessionUpdate: "available_commands_update"` in `parseSessionUpdateEvent`
- [ ] 1.3 Add focused parser tests covering an empty list, a command with an input hint, and a
      republished set

## 2. Session runtime

- [ ] 2.1 Hold the current command set in `AcpSessionRuntime` and replace it on each advertisement
- [ ] 2.2 Expose the command set through the runtime service and forward the parsed event to the
      event queue
- [ ] 2.3 Reset the command set when a session is replaced or resumed

## 3. Contracts

- [ ] 3.1 Add an available-commands payload to `packages/contracts` runtime events
- [ ] 3.2 Add the command set to thread session state so clients can read it
- [ ] 3.3 Update contract tests

## 4. Adapters

- [ ] 4.1 Emit the runtime event from `KimiAdapter`, exempting it from the active-turn gate the same
      way `ConfigOptionsChanged` is
- [ ] 4.2 Do the same in `CursorAdapter` and `GrokAdapter`
- [ ] 4.3 Confirm against a live handshake which of Cursor and Grok advertise commands, and record
      the result in this change before scoping the composer work
- [ ] 4.4 Add focused adapter tests

## 5. Composer

- [ ] 5.1 Render advertised commands with name and description, dismissible and keyboard-navigable
- [ ] 5.2 Accept an optional argument for commands that declare an input hint
- [ ] 5.3 Dispatch the selection through the existing send path
- [ ] 5.4 Leave a literal leading `/` untouched when no command is selected
- [ ] 5.5 Add focused web tests

## 6. Activity recording

- [ ] 6.1 Record command turns in thread activity so a context-altering command is visible
- [ ] 6.2 Decide and implement whether a command turn is visually distinguished from a user message

## 7. Verification

- [ ] 7.1 Run the focused server and web tests for the touched files
- [ ] 7.2 Verify `/compact` end to end against a real Kimi session using the `test-t3-app` skill
