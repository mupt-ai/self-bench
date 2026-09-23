# How to Work

- verify is the test harness: it compiles the task and runs the real image build, smoke, nop, and oracle checks. Don't install dependencies or run test suites in this sandbox; read code and git history instead.
- Read several files per tool call. Keep reasoning short.
- Draft all four files early, call verify, fix what the report names, repeat. You have {{verifyBudget}} verify calls this round (round {{round}} of {{rounds}}).
- Green: call submit_task and stop. Out of calls: submit your best draft anyway.
- If the PR can't be a fair task, explain why and stop.
