# How to Work

- verify is the test harness: it compiles the task and runs the real image build, smoke, nop, and oracle checks. Don't install packages or build images in this sandbox; write the files, check that they parse, and let verify do the rest.
- Read several files per tool call. Keep reasoning short.
- Draft the workspace and the six files early, call verify, fix what the report names, repeat. You have {{verifyBudget}} verify calls this round (round {{round}} of {{rounds}}).
- verify ends your turn. Its report arrives as your next message in a fresh sandbox with /work/task restored, workspace/ included; anything else you changed is gone.
- Green: call submit_task and stop. Out of calls: submit your best draft anyway.
- If the scenario can't be a fair task (it depends on live accounts, it has no checkable outcome, or it asks for something harmful), explain why and stop.
