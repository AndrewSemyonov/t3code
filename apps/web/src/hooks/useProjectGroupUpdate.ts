import { AuthOrchestrationOperateScope, type ProjectIconOverride } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export type ProjectGroupUpdate = Partial<{
  title: string;
  faviconPath: string | null;
  projectIcon: ProjectIconOverride | null;
  pinned: boolean;
  archived: boolean;
}>;

type ProjectGroupMember = Pick<
  SidebarProjectGroupMember,
  "environmentId" | "id" | "environmentLabel"
>;

/**
 * Writes one update to each checkout of a project, one machine at a time, and
 * reports the first failure as a toast. Every machine must be connected first.
 */
export function useProjectGroupUpdate() {
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const fail = (title: string, error: Error): AtomCommandResult<void, unknown> => {
    const result = AsyncResult.failure<void, Error>(Cause.fail(error));
    reportFailure(title, result);
    return result;
  };

  const accessError = (member: ProjectGroupMember) =>
    readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope)
      ? null
      : new Error(
          `This connection cannot change projects in ${member.environmentLabel ?? "this environment"}.`,
        );

  const updateProjectGroup = async (
    members: ReadonlyArray<ProjectGroupMember>,
    input: ProjectGroupUpdate,
    failureTitle: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    const denied = members.map(accessError).find((error) => error !== null);
    if (denied) return fail(failureTitle, denied);
    const unavailable = members.find((member) => {
      const environment = environmentById.get(member.environmentId);
      return environment?.connection.phase !== "connected" || !environment.serverConfig;
    });
    if (unavailable) {
      return fail(
        failureTitle,
        new Error(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        ),
      );
    }
    for (const member of members) {
      // Access can be revoked between writes.
      const revoked = accessError(member);
      if (revoked) return fail(failureTitle, revoked);
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, ...input },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportFailure(
          members.length > 1
            ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
            : failureTitle,
          result,
        );
        return result;
      }
    }
    return AsyncResult.success(undefined);
  };

  /** Older servers drop pin and archive, so their projects do not offer them. */
  const canOrganizeProjectGroup = (members: ReadonlyArray<ProjectGroupMember>) =>
    members.every(
      (member) =>
        environmentById.get(member.environmentId)?.serverConfig?.environment.capabilities
          .projectOrganization === true,
    );

  return { updateProjectGroup, canOrganizeProjectGroup };
}

function reportFailure(title: string, result: AtomCommandResult<void, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
