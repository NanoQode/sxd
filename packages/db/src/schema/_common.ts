import { sql } from 'drizzle-orm';
import { bigint, customType, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Non-point PostGIS geometries are exchanged as GeoJSON text. Reads go through
 * explicit ST_AsGeoJSON in reviewed SQL; writes wrap the GeoJSON with
 * ST_GeomFromGeoJSON. The column type carries the geometry signature and SRID
 * so migrations are generated correctly.
 */
export const geometryMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(MultiPolygon,4326)';
  },
  toDriver(value: string) {
    return sql`ST_SetSRID(ST_GeomFromGeoJSON(${value}), 4326)` as unknown as string;
  },
  fromDriver(value: string) {
    return value;
  },
});

export interface LonLat {
  lon: number;
  lat: number;
}

/** Parses a hex EWKB/WKB Point as returned by PostGIS into longitude/latitude. */
export function parsePointEwkb(hex: string): LonLat {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 21) throw new Error('Invalid EWKB point');
  const little = buf[0] === 1;
  let offset = 1;
  const rawType = little ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
  offset += 4;
  const hasSrid = (rawType & 0x20000000) !== 0;
  if (hasSrid) offset += 4;
  const geomType = rawType & 0x0fffffff;
  if (geomType !== 1) throw new Error(`Expected Point geometry, got type ${geomType}`);
  const x = little ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
  const y = little ? buf.readDoubleLE(offset + 8) : buf.readDoubleBE(offset + 8);
  return { lon: x, lat: y };
}

/** WGS84 point column (SRID 4326). Values are {lon, lat}. */
export const geometryPoint = customType<{ data: LonLat; driverData: string }>({
  dataType() {
    return 'geometry(Point,4326)';
  },
  toDriver(value: LonLat) {
    return sql`ST_SetSRID(ST_MakePoint(${value.lon}, ${value.lat}), 4326)` as unknown as string;
  },
  fromDriver(value: string) {
    return parsePointEwkb(value);
  },
});

export const geometryPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(Polygon,4326)';
  },
  toDriver(value: string) {
    return sql`ST_SetSRID(ST_GeomFromGeoJSON(${value}), 4326)` as unknown as string;
  },
  fromDriver(value: string) {
    return value;
  },
});

/**
 * Shared column builders. Column names are derived from property names using
 * Drizzle's snake_case casing (see drizzle.config.ts and client.ts).
 */

export const id = () => uuid().primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp({ withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tstz = () => timestamp({ withTimezone: true, mode: 'date' });

/** Integer kobo. Never store naira as floating point. */
export const kobo = () => bigint({ mode: 'bigint' });

export const koboNotNull = () => bigint({ mode: 'bigint' }).notNull();

export const koboZero = () =>
  bigint({ mode: 'bigint' })
    .notNull()
    .default(sql`0`);

export const currency = () => text().notNull().default('NGN');

/** Optimistic-concurrency version counter incremented by the application. */
export const version = () => integer().notNull().default(1);

export const jsonObject = <T>() => jsonb().$type<T>();

export const jsonObjectNotNull = <T>(defaultValue: T) =>
  jsonb()
    .$type<T>()
    .notNull()
    .default(sql`'${sql.raw(JSON.stringify(defaultValue))}'::jsonb`);

export const emptyJsonArray = <T>() => jsonObjectNotNull<T[]>([]);

export const emptyJsonObject = <T extends Record<string, unknown>>() =>
  jsonObjectNotNull<T>({} as T);
