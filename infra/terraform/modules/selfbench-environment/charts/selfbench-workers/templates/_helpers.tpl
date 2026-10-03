{{/*
Autopilot workload separation: worker pods select nodes labelled for them, and tolerate the taint
Autopilot puts on those nodes, so system Deployments that cannot tolerate it never land there or
preempt a worker to make room. Billing stays per pod request.
*/}}
{{- define "selfbench-workers.separation" -}}
nodeSelector:
  selfbench.dev/workers: "true"
tolerations:
  - key: selfbench.dev/workers
    operator: Equal
    value: "true"
    effect: NoSchedule
{{- end }}
