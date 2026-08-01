import { z } from "zod";
import { observable } from "@trpc/server/observable";
import { createRouter, procedure } from "../trpc";
import type {
  AgentPermissionRequest,
  AgentSessionSummary,
  AgentTimelineEntry,
} from "@/services/agent/types";

const permissionMode = z.enum([
  "default",
  "dontAsk",
  "plan",
  "bypassPermissions",
]);

export const agentRouter = createRouter({
  listSessions: procedure.query(({ ctx }) =>
    ctx.serviceManager.getService("agentService").listSessions(),
  ),

  getSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.serviceManager.getService("agentService").getSession(input.sessionId),
    ),

  getTimeline: procedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.serviceManager
        .getService("agentService")
        .getTimeline(input.sessionId),
    ),

  createSession: procedure
    .input(
      z.object({
        cwd: z.string().min(1),
        model: z.string().optional(),
        permissionMode: permissionMode.optional(),
        resume: z.string().optional(),
        fork: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.serviceManager.getService("agentService").createSession(input),
    ),

  sendMessage: procedure
    .input(z.object({ sessionId: z.string(), text: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      ctx.serviceManager
        .getService("agentService")
        .sendMessage(input.sessionId, input.text);
      return { ok: true };
    }),

  interrupt: procedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.serviceManager
        .getService("agentService")
        .interrupt(input.sessionId);
      return { ok: true };
    }),

  setPermissionMode: procedure
    .input(z.object({ sessionId: z.string(), mode: permissionMode }))
    .mutation(async ({ ctx, input }) => {
      await ctx.serviceManager
        .getService("agentService")
        .setPermissionMode(input.sessionId, input.mode);
      return { ok: true };
    }),

  setModel: procedure
    .input(z.object({ sessionId: z.string(), model: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.serviceManager
        .getService("agentService")
        .setModel(input.sessionId, input.model);
      return { ok: true };
    }),

  resolvePermission: procedure
    .input(
      z.object({
        sessionId: z.string(),
        requestId: z.string(),
        allow: z.boolean(),
        reason: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      ctx.serviceManager
        .getService("agentService")
        .resolvePermission(input.sessionId, input.requestId, {
          allow: input.allow,
          reason: input.reason,
        });
      return { ok: true };
    }),

  closeSession: procedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.serviceManager
        .getService("agentService")
        .closeSession(input.sessionId);
      return { ok: true };
    }),

  // Observables rather than async generators: electron-trpc conflicts with the
  // native Symbol.asyncDispose on generators (same workaround as recording.ts).
  // eslint-disable-next-line deprecation/deprecation
  sessionUpdates: procedure.subscription(({ ctx }) => {
    return observable<AgentSessionSummary>((emit) => {
      const agentService = ctx.serviceManager.getService("agentService");

      // Seed the subscriber so it renders current state without a separate
      // query racing the first event.
      for (const session of agentService.listSessions()) {
        emit.next(session);
      }

      const onUpdate = (summary: AgentSessionSummary) => emit.next(summary);
      agentService.on("session-updated", onUpdate);
      return () => {
        agentService.off("session-updated", onUpdate);
      };
    });
  }),

  // eslint-disable-next-line deprecation/deprecation
  timelineUpdates: procedure
    .input(z.object({ sessionId: z.string() }))
    .subscription(({ ctx, input }) => {
      return observable<AgentTimelineEntry>((emit) => {
        const agentService = ctx.serviceManager.getService("agentService");

        const onEntry = (event: {
          sessionId: string;
          entry: AgentTimelineEntry;
        }) => {
          if (event.sessionId === input.sessionId) {
            emit.next(event.entry);
          }
        };

        agentService.on("session-entry", onEntry);
        return () => {
          agentService.off("session-entry", onEntry);
        };
      });
    }),

  // eslint-disable-next-line deprecation/deprecation
  permissionRequests: procedure.subscription(({ ctx }) => {
    return observable<
      | { type: "requested"; request: AgentPermissionRequest }
      | { type: "resolved"; requestId: string; sessionId: string }
    >((emit) => {
      const agentService = ctx.serviceManager.getService("agentService");

      const onRequested = (request: AgentPermissionRequest) =>
        emit.next({ type: "requested", request });
      const onResolved = (event: { requestId: string; sessionId: string }) =>
        emit.next({ type: "resolved", ...event });

      agentService.on("permission-requested", onRequested);
      agentService.on("permission-resolved", onResolved);
      return () => {
        agentService.off("permission-requested", onRequested);
        agentService.off("permission-resolved", onResolved);
      };
    });
  }),
});
