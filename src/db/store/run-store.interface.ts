import type {
  RunRecord,
  RunStartPayload,
  ShardFinishPayload,
  TestEndPayload,
} from "../../types.js";

export interface IRunStore {
  listRuns(): Promise<RunRecord[]>;
  getRun(ciBuildId: string): Promise<RunRecord | null>;
  startRun(payload: RunStartPayload): Promise<RunRecord>;
  reportTest(payload: TestEndPayload): Promise<RunRecord>;
  addArtifact(
    meta: {
      ciBuildId: string;
      shardNumber: number;
      testId: string;
      retryIndex: number;
      specPath: string;
      name: string;
      contentType: string;
    },
    filePath: string,
    sizeBytes?: number,
  ): Promise<RunRecord>;
  finishShard(payload: ShardFinishPayload): Promise<RunRecord>;
  getArtifactFile?(
    artifactId: string,
  ): Promise<{ filePath: string; contentType: string; name: string; projectId: string } | null>;
  close?(): Promise<void>;
}
