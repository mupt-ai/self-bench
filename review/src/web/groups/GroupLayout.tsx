import { GroupScope } from "../evaluation/useEvaluationScope";
import { ScopeLayout } from "../ScopeLayout";

/**
 * One repository group: a repository's Dataset, Run, and Results pages over every member's
 * approved tasks, and its own Releases and Settings.
 */
export function GroupLayout() {
  return (
    <GroupScope>
      <ScopeLayout
        afterResults={[
          { path: "/releases", label: "Releases" },
          { path: "/settings", label: "Settings" },
        ]}
      />
    </GroupScope>
  );
}
