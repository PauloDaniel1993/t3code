# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

## Terminals in multi-root projects

A new terminal opens in the thread's primary folder, inside its worktree when it has one. To open
one in another workspace folder, choose **Open terminal here** from that folder's menu in thread
details. On mobile, the terminal screen also offers **Open terminal in folder**. A terminal stays
in the folder it opened in.
