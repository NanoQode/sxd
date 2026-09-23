/**
 * Development-only demo accounts and sample data. Refused unless
 * APP_ENV is development or test AND ENABLE_DEMO_SEED=true.
 *
 * Usage: pnpm --filter @simplexd/web seed:demo
 */
import { eq } from 'drizzle-orm';
import { appendOutbox, getDb, schema, systemContext, withActor } from '@simplexd/db';

const appEnv = process.env.APP_ENV ?? 'development';
if (!(appEnv === 'development' || appEnv === 'test') || process.env.ENABLE_DEMO_SEED !== 'true') {
  console.error(
    'Demo seeding is refused outside development/test or when ENABLE_DEMO_SEED is not "true".',
  );
  process.exit(2);
}

const { auth } = await import('../src/lib/auth/server');
const db = getDb();

interface DemoUser {
  email: string;
  name: string;
  password: string;
  staffRoles?: Array<(typeof schema.staffRoleEnum.enumValues)[number]>;
  partner?: { type: (typeof schema.partnerTypeEnum.enumValues)[number]; displayName: string };
  organization?: { name: string; slug: string; role: 'owner' | 'member' | 'adviser' | 'approver' };
}

export const DEMO_PASSWORD = 'DemoPassword-2026!';

export const demoUsers: DemoUser[] = [
  {
    email: 'admin@demo.simplexd.local',
    name: 'Demo Super Admin',
    password: DEMO_PASSWORD,
    staffRoles: ['super_admin'],
  },
  {
    email: 'ops@demo.simplexd.local',
    name: 'Demo Operations Manager',
    password: DEMO_PASSWORD,
    staffRoles: ['operations_manager'],
  },
  {
    email: 'pm@demo.simplexd.local',
    name: 'Demo Project Manager',
    password: DEMO_PASSWORD,
    staffRoles: ['project_manager'],
  },
  {
    email: 'inspector@demo.simplexd.local',
    name: 'Demo Inspector',
    password: DEMO_PASSWORD,
    staffRoles: ['inspector'],
  },
  {
    email: 'finance@demo.simplexd.local',
    name: 'Demo Finance',
    password: DEMO_PASSWORD,
    staffRoles: ['finance'],
  },
  {
    email: 'data-editor@demo.simplexd.local',
    name: 'Demo Data Editor',
    password: DEMO_PASSWORD,
    staffRoles: ['data_editor'],
  },
  {
    email: 'data-approver@demo.simplexd.local',
    name: 'Demo Data Approver',
    password: DEMO_PASSWORD,
    staffRoles: ['data_approver'],
  },
  {
    email: 'content@demo.simplexd.local',
    name: 'Demo Content Editor',
    password: DEMO_PASSWORD,
    staffRoles: ['content_editor'],
  },
  {
    email: 'support@demo.simplexd.local',
    name: 'Demo Support',
    password: DEMO_PASSWORD,
    staffRoles: ['support'],
  },
  {
    email: 'contractor@demo.simplexd.local',
    name: 'Demo Contractor',
    password: DEMO_PASSWORD,
    partner: { type: 'contractor', displayName: 'Demo Build Co.' },
  },
  {
    email: 'surveyor@demo.simplexd.local',
    name: 'Demo Surveyor',
    password: DEMO_PASSWORD,
    partner: { type: 'surveyor', displayName: 'Demo Survey Partners' },
  },
  {
    email: 'owner@demo.simplexd.local',
    name: 'Demo Customer Owner',
    password: DEMO_PASSWORD,
    organization: { name: 'Adeyemi Family Holdings', slug: 'adeyemi-family', role: 'owner' },
  },
  {
    email: 'member@demo.simplexd.local',
    name: 'Demo Customer Member',
    password: DEMO_PASSWORD,
    organization: { name: 'Adeyemi Family Holdings', slug: 'adeyemi-family', role: 'member' },
  },
  {
    email: 'other-owner@demo.simplexd.local',
    name: 'Demo Other Customer',
    password: DEMO_PASSWORD,
    organization: { name: 'Okoro Ventures', slug: 'okoro-ventures', role: 'owner' },
  },
  { email: 'tenant@demo.simplexd.local', name: 'Demo Tenant', password: DEMO_PASSWORD },
];

async function ensureUser(u: DemoUser): Promise<string> {
  const existing = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, u.email));
  if (existing[0]) return existing[0].id;
  const res = await auth.api.signUpEmail({
    body: { email: u.email, password: u.password, name: u.name },
  });
  const id = res.user.id;
  await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, id));
  return id;
}

async function ensureOrganization(
  name: string,
  slug: string,
  creatorUserId: string,
): Promise<string> {
  const existing = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug));
  if (existing[0]) return existing[0].id;
  const id = `org_${slug.replace(/-/g, '')}`;
  await db.insert(schema.organization).values({ id, name, slug, createdAt: new Date() });
  await db
    .insert(schema.organizationProfiles)
    .values({ organizationId: id, kind: 'customer' })
    .onConflictDoNothing();
  await db
    .insert(schema.member)
    .values({
      id: `mem_${slug}_${creatorUserId.slice(0, 8)}`,
      organizationId: id,
      userId: creatorUserId,
      role: 'owner',
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  return id;
}

async function main(): Promise<void> {
  const ids = new Map<string, string>();
  for (const u of demoUsers) {
    const id = await ensureUser(u);
    ids.set(u.email, id);
    await withActor(db, systemContext('seed-demo'), async (tx) => {
      if (u.staffRoles) {
        for (const role of u.staffRoles) {
          await tx
            .insert(schema.staffRoles)
            .values({ userId: id, role, reason: 'demo seed' })
            .onConflictDoNothing();
        }
      }
      if (u.partner) {
        await tx
          .insert(schema.partnerProfiles)
          .values({
            userId: id,
            partnerType: u.partner.type,
            displayName: u.partner.displayName,
            verificationStatus: 'verified',
            verifiedAt: new Date(),
            verificationScope: 'Demo seed: no real credential checks performed.',
          })
          .onConflictDoNothing();
      }
    });
  }
  for (const u of demoUsers) {
    if (!u.organization) continue;
    const userId = ids.get(u.email)!;
    const orgId = await ensureOrganization(u.organization.name, u.organization.slug, userId);
    await db
      .insert(schema.member)
      .values({
        id: `mem_${u.organization.slug}_${userId.slice(0, 8)}`,
        organizationId: orgId,
        userId,
        role: u.organization.role,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }
  await withActor(db, systemContext('seed-demo'), async (tx) => {
    await appendOutbox(tx, {
      eventType: 'demo.seeded',
      aggregateType: 'system',
      aggregateId: 'demo',
      payload: { users: demoUsers.length },
    });
    await tx
      .insert(schema.auditEvents)
      .values({
        actorType: 'system',
        action: 'demo.seeded',
        entityType: 'system',
        reason: 'seed-demo script',
      });
  });
  console.log(`Demo accounts ready (${demoUsers.length}). Password for all: ${DEMO_PASSWORD}`);
  console.log(
    demoUsers
      .map(
        (u) =>
          `  ${u.email}  ${u.staffRoles?.join(',') ?? u.partner?.type ?? u.organization?.role ?? 'tenant'}`,
      )
      .join('\n'),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
