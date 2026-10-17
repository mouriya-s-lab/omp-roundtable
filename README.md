# omp-roundtable
Roundtable delivers ordered GitHub issues through isolated OMP seats, durable local protocol state, source-confirmed effects, and fresh independent gates.

Load the extension with `omp -e ./index.ts`, then use `/roundtable` in Main. The `roundtable` tool accepts a strict `{"input": ...}` object. Main plans or convenes an agenda, acknowledges native async isolated seat creation, and handles decision tickets; current owner and gate seats use `tickets` and `reply`.

The controller persists accepted replies and external-write intents before returning, then executes and confirms each effect separately. An existing active agenda requires an explicit `resume` confirmation that the original process ended. `/roundtable off` refuses unfinished agendas.
