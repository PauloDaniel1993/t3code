# Flows

A flow connects agent, command, approval, loop and map steps into repeatable work. Flow files live in your project's `.t3code/flow/<id>.json`, so you can version and share them with the project.

On web or desktop, open the **Flow panel**, create a flow, add steps and connect them. Select a step or edge to edit it; use Flow settings for inputs, defaults and the workspace. Invalid flows can be saved while you fix them, but cannot be started. Start a valid flow by supplying its inputs and, optionally, a base ref. Each flow run keeps a snapshot of the definition, so edits affect future flow runs.

Watch progress in the Flow panel or open the flow run thread. Its step list opens individual step threads. You can stop a flow run, resume a stopped flow run, retry a failed or interrupted step, and approve or reject a waiting approval with an optional comment. Mobile supports this monitoring and these actions, but cannot build, start or schedule flows.

Waiting approvals mark the flow run thread as needing input; finishing a flow run marks it unread. After a server restart, agent steps wait for their thread's automatic continuation. If that continuation is disabled or cannot happen, the step is interrupted and can be retried. Running command steps are interrupted; approvals keep waiting.

Choose **Schedule…** in the Flow panel, or select **Flow** when creating a scheduled task in Settings or a thread's automations. Pick a flow, enter input templates and choose an interval, fixed time or webhook trigger. Webhook inputs can use placeholders such as `{{body.issue.title}}`, `{{headers.name}}` and `{{query.name}}`. Lists accept a JSON array or one item per line. A scheduled task's success means the flow run started; its separate flow-run status shows how the work finished. A trigger is skipped while the same task's previous flow run is still active. Flow schedules are read-only on mobile.

Loops require `maxIterations`; reaching it completes the loop successfully even when its `until` condition is not met. Joins wait for incoming edges to be resolved, then wait only for the branches actually taken; a step with no taken incoming edge is skipped. Agent steps use a new thread by default. Use `sameAs` to continue an earlier agent step's thread, or `continue` inside a loop to reuse that step's thread between iterations.

Prompts can reference inputs and earlier outputs, such as `{{inputs.issue}}` or `{{steps.review.output.text}}`. Loop outputs nest final-iteration results under `steps.<loop>.output.steps.<innerStep>`. Missing values render as empty text. Command text is literal: pass dynamic values through the command step's `env` map and read those variables in your shell. Lists in environment variables are joined with newlines.

Agent step prompts can include images; pasted images are saved under `.t3code/flow/images/` so they can be versioned with the flow.
