import { z } from "npm:zod@4.3.6";
import {
  appspaceApi,
  AppspaceGlobalArgsSchema,
  appspacePaged,
  sanitizeId,
} from "./_client.ts";

const UserSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  userName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  userType: z.string().optional(),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
  homeLocation: z.record(z.string(), z.unknown()).optional(),
  memberships: z.array(z.record(z.string(), z.unknown())).optional(),
  roles: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();

const UserGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  networkId: z.string().optional(),
  networkName: z.string().optional(),
  userGroupType: z.string().optional(),
  roles: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough();

/**
 * `@dougschaefer/appspace-user` model — directory and identity lookups on an
 * Appspace tenant. Covers list, get-by-id, current-user (`me`), find-by-
 * email (paginated client-side because the `?email=` filter is silently
 * ignored), group membership listing, and group-member enumeration. The
 * user shape exposes both `id` (the tenant-local UUID) and `cloudGuid`
 * (the cross-tenant identity) — these are distinct.
 */
export const model = {
  type: "@dougschaefer/appspace-user",
  version: "2026.07.30.1",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    user: {
      description:
        "Appspace user — directory record with email, location, roles, group memberships",
      schema: UserSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    userGroup: {
      description: "Appspace user group with role assignments and network",
      schema: UserGroupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    me: {
      description:
        "Current user (the Service Account behind the API token); useful to confirm token identity",
      schema: UserSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description:
        "Query users with pagination. Returns the full user directory by default; pass maxItems to cap.",
      arguments: z.object({
        maxItems: z.number().optional().default(2000).describe(
          "Maximum users to return",
        ),
        userType: z.string().optional().describe(
          "Filter by user type (e.g. 'User', 'Visitor')",
        ),
      }),
      execute: async (args, context) => {
        const params: Record<string, string | number> = {};
        if (args.userType) params.userType = args.userType;

        const users = await appspacePaged("/api/v3/users", context.globalArgs, {
          params,
          maxItems: args.maxItems,
        });
        context.logger.info("Found {count} users", { count: users.length });

        const handles = [];
        for (const u of users) {
          const name = sanitizeId(
            (u.email as string) ?? (u.userName as string) ?? (u.id as string),
          );
          const handle = await context.writeResource("user", name, u);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a specific user by ID.",
      arguments: z.object({
        id: z.string().describe("User UUID"),
      }),
      execute: async (args, context) => {
        const user = await appspaceApi(
          `/api/v3/users/${encodeURIComponent(args.id)}`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const name = sanitizeId(
          (user.email as string) ?? (user.id as string) ?? args.id,
        );
        const handle = await context.writeResource("user", name, user);
        return { dataHandles: [handle] };
      },
    },

    findByEmail: {
      description:
        "Find users by email — workaround for the missing email-filter on /users. Pages through the directory and matches case-insensitively. Returns the matched user(s) as data; logs a warning if directory exceeds maxScan.",
      arguments: z.object({
        email: z.string().describe(
          "Email to find (case-insensitive). Substring match by default.",
        ),
        exact: z.boolean().default(true).describe(
          "When true, match exact email; when false, substring match.",
        ),
        maxScan: z.number().optional().default(5000).describe(
          "Maximum directory entries to scan before giving up",
        ),
      }),
      execute: async (args, context) => {
        const target = args.email.toLowerCase();
        const matches: Array<Record<string, unknown>> = [];

        let start = 0;
        const limit = 200;
        let scanned = 0;
        while (scanned < args.maxScan) {
          const page = await appspaceApi(
            "/api/v3/users",
            context.globalArgs,
            { params: { start, limit } },
          ) as { items?: Array<Record<string, unknown>> } | null;
          if (!page || !page.items || page.items.length === 0) break;
          for (const u of page.items) {
            scanned += 1;
            const ue = String(u.email ?? u.userName ?? "").toLowerCase();
            if (!ue) continue;
            if (args.exact ? ue === target : ue.includes(target)) {
              matches.push(u);
            }
          }
          if (page.items.length < limit) break;
          start += page.items.length;
        }

        if (scanned >= args.maxScan && matches.length === 0) {
          context.logger.warning(
            "Scanned {n} entries without finding {email}; consider raising maxScan",
            { n: scanned, email: args.email },
          );
        }

        context.logger.info(
          "Found {n} match(es) for {email} after scanning {scanned}",
          { n: matches.length, email: args.email, scanned },
        );

        const handles = [];
        for (const u of matches) {
          const name = sanitizeId((u.email as string) ?? (u.id as string));
          const handle = await context.writeResource("user", name, u);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    me: {
      description:
        "Get the current user (the Service Account behind the API token). Useful for confirming token identity and inspecting account context.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const me = await appspaceApi(
          "/api/v3/users/me",
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "me",
          sanitizeId((me.email as string) ?? "me"),
          me,
        );
        return { dataHandles: [handle] };
      },
    },

    listGroups: {
      description: "List all user groups in the account.",
      arguments: z.object({
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const groups = await appspacePaged(
          "/api/v3/users/usergroups",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        context.logger.info("Found {count} user groups", {
          count: groups.length,
        });
        const handles = [];
        for (const g of groups) {
          const name = sanitizeId((g.name as string) ?? (g.id as string));
          const handle = await context.writeResource("userGroup", name, g);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getGroupMembers: {
      description: "List members of a specific user group.",
      arguments: z.object({
        groupId: z.string().describe("User group UUID"),
        maxItems: z.number().optional().default(1000),
      }),
      execute: async (args, context) => {
        const members = await appspacePaged(
          `/api/v3/users/usergroups/${
            encodeURIComponent(args.groupId)
          }/members`,
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        const handles = [];
        for (const u of members) {
          const name = sanitizeId(
            (u.email as string) ?? (u.id as string) ?? "member",
          );
          const handle = await context.writeResource("user", name, u);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },
  },
};
