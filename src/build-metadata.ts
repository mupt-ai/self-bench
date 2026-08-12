const unsetBuildCommit = "0".repeat(40);

export const buildCommit = process.env.SELFBENCH_BUILD_COMMIT ?? unsetBuildCommit;
