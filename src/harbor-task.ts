export type { AuthoredTaskFiles } from "./harbor-task/compiler.js";
export { compileHarborTask, loadAuthoredTask, refreshHarborTask } from "./harbor-task/compiler.js";
export {
  dependencyManifestPatch,
  goldPatchChangesDependencyManifests,
} from "./harbor-task/dependencies.js";
