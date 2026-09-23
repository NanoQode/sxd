import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { getDb, schema, withActor } from '@simplexd/db';
import type { RequestIdentity } from '@/lib/auth/session';

/** Appointments booked against a service request (the DTO carries no request id). */
export interface LinkedAppointment {
  id: string;
  kind: string;
  status: string;
  startsAt: string;
  endsAt: string;
  customerTimeZone: string;
  businessTimeZone: string;
  topic: string | null;
  meetingProvider: string;
  conferenceStatus: string;
  staffName: string | null;
}

export async function listRequestAppointments(
  identity: RequestIdentity,
  serviceRequestId: string,
): Promise<LinkedAppointment[]> {
  if (!identity.session) return [];
  const rows = await withActor(getDb(), identity.ctx, (tx) =>
    tx
      .select({ a: schema.appointments, staffName: schema.user.name })
      .from(schema.appointments)
      .leftJoin(schema.user, eq(schema.user.id, schema.appointments.staffUserId))
      .where(eq(schema.appointments.serviceRequestId, serviceRequestId))
      .orderBy(asc(schema.appointments.startsAt))
      .limit(50),
  );
  return rows.map(({ a, staffName }) => ({
    id: a.id,
    kind: a.kind,
    status: a.status,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    customerTimeZone: a.customerTimeZone,
    businessTimeZone: a.businessTimeZone,
    topic: a.topic,
    meetingProvider: a.meetingProvider,
    conferenceStatus: a.conferenceStatus,
    staffName,
  }));
}
