/**
 * Seed de datos de "Grupo Norte" para desarrollo y demo.
 * Repetible: limpia las tablas de la app (en orden hijo -> padre) antes de
 * volver a insertar, así se puede correr tantas veces como se quiera.
 */

import { env } from "../src/config/env.js";
import { prisma } from "../src/db/prisma.js";
import { hashPassword } from "../src/security/password.js";
import { countBusinessDays } from "../src/domain/vacation.js";
import {
  BalanceAdjustmentType,
  RequestEventAction,
  Role,
  type LeaveRequestStatus,
} from "../src/generated/prisma/enums.js";

if (env.NODE_ENV === "production") {
  throw new Error(
    "Refusing to run the seed with NODE_ENV=production: this script deletes all data.",
  );
}

// ---------- Festivos oficiales (Art. 74 LFT) ----------

const HOLIDAYS_DATA: { date: string; name: string }[] = [
  { date: "2026-01-01", name: "Año Nuevo" },
  { date: "2026-02-02", name: "Día de la Constitución" },
  { date: "2026-03-16", name: "Natalicio de Benito Juárez" },
  { date: "2026-05-01", name: "Día del Trabajo" },
  { date: "2026-09-16", name: "Día de la Independencia" },
  { date: "2026-11-16", name: "Día de la Revolución Mexicana" },
  { date: "2026-12-25", name: "Navidad" },
  { date: "2027-01-01", name: "Año Nuevo" },
  { date: "2027-02-01", name: "Día de la Constitución" },
  { date: "2027-03-15", name: "Natalicio de Benito Juárez" },
  { date: "2027-05-01", name: "Día del Trabajo" },
  { date: "2027-09-16", name: "Día de la Independencia" },
  { date: "2027-11-15", name: "Día de la Revolución Mexicana" },
  { date: "2027-12-25", name: "Navidad" },
];

const HOLIDAY_DATES = HOLIDAYS_DATA.map((h) => d(h.date));

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function dt(iso: string): Date {
  return new Date(`${iso}.000Z`);
}

// ---------- Catálogos ----------

const DEPARTMENTS = [
  "Dirección General",
  "Recursos Humanos",
  "Tecnología",
  "Ventas",
  "Operaciones",
  "Finanzas",
] as const;

const LEAVE_TYPES = [
  { code: "VAC", name: "Vacaciones", countsAgainstVacationBalance: true },
  { code: "PERM_GOCE", name: "Permiso con goce de sueldo", countsAgainstVacationBalance: false },
  { code: "PERM_SIN_GOCE", name: "Permiso sin goce de sueldo", countsAgainstVacationBalance: false },
  { code: "PERSONAL", name: "Día personal", countsAgainstVacationBalance: false },
] as const;

// ---------- Personas de Grupo Norte ----------

type UserSeed = {
  key: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  hireDate: string;
  department: (typeof DEPARTMENTS)[number];
  manager: string | null;
};

const USERS: UserSeed[] = [
  // Dirección General — caso "12 años"
  { key: "director", email: "eduardo.villanueva@gruponorte.mx", firstName: "Eduardo", lastName: "Villanueva Cantú", role: Role.MANAGER, hireDate: "2014-03-03", department: "Dirección General", manager: null },

  // Recursos Humanos — rh@demo.com es el caso "5 años"
  { key: "rh1", email: "rh@demo.com", firstName: "Alejandra", lastName: "Reyes Domínguez", role: Role.HR, hireDate: "2020-11-01", department: "Recursos Humanos", manager: "director" },
  { key: "rh2", email: "mauricio.salinas@gruponorte.mx", firstName: "Mauricio", lastName: "Salinas Treviño", role: Role.HR, hireDate: "2017-01-15", department: "Recursos Humanos", manager: "director" },

  // Gerentes de los 4 departamentos operativos
  { key: "jefeTec", email: "jefe@demo.com", firstName: "Ricardo", lastName: "Montemayor Elizondo", role: Role.MANAGER, hireDate: "2018-06-15", department: "Tecnología", manager: "director" },
  { key: "gerenteVentas", email: "patricia.garza@gruponorte.mx", firstName: "Patricia", lastName: "Garza Longoria", role: Role.MANAGER, hireDate: "2016-04-10", department: "Ventas", manager: "director" },
  { key: "gerenteOperaciones", email: "jorge.luna@gruponorte.mx", firstName: "Jorge", lastName: "Luna Cepeda", role: Role.MANAGER, hireDate: "2015-11-20", department: "Operaciones", manager: "director" },
  { key: "gerenteFinanzas", email: "humberto.saldana@gruponorte.mx", firstName: "Humberto", lastName: "Saldaña Rocha", role: Role.MANAGER, hireDate: "2019-09-10", department: "Finanzas", manager: "director" }, // caso "7 años"

  // Tecnología (5 empleados)
  { key: "empleadoDemo", email: "empleado@demo.com", firstName: "Fernando", lastName: "Garza Elizondo", role: Role.EMPLOYEE, hireDate: "2023-02-01", department: "Tecnología", manager: "jefeTec" }, // caso "3 años"
  { key: "tec5anios", email: "daniela.cantu@gruponorte.mx", firstName: "Daniela", lastName: "Cantú Villarreal", role: Role.EMPLOYEE, hireDate: "2021-02-22", department: "Tecnología", manager: "jefeTec" }, // caso "5 años"
  { key: "tecNormal1", email: "rodrigo.ibarra@gruponorte.mx", firstName: "Rodrigo", lastName: "Ibarra Montes", role: Role.EMPLOYEE, hireDate: "2017-05-10", department: "Tecnología", manager: "jefeTec" },
  { key: "tecNormal2", email: "sofia.benavides@gruponorte.mx", firstName: "Sofía", lastName: "Benavides Rangel", role: Role.EMPLOYEE, hireDate: "2024-07-01", department: "Tecnología", manager: "jefeTec" },
  { key: "tecNormal3", email: "omar.cardenas@gruponorte.mx", firstName: "Omar", lastName: "Cárdenas Zúñiga", role: Role.EMPLOYEE, hireDate: "2015-01-20", department: "Tecnología", manager: "jefeTec" },

  // Ventas (4 empleados)
  { key: "ventasMenos1anio", email: "brenda.najera@gruponorte.mx", firstName: "Brenda", lastName: "Nájera Soto", role: Role.EMPLOYEE, hireDate: "2026-05-04", department: "Ventas", manager: "gerenteVentas" }, // caso "<1 año"
  { key: "ventas1anio", email: "gustavo.pena@gruponorte.mx", firstName: "Gustavo", lastName: "Peña Alanís", role: Role.EMPLOYEE, hireDate: "2025-08-01", department: "Ventas", manager: "gerenteVentas" }, // caso "1 año"
  { key: "ventasCancelada", email: "claudia.morales@gruponorte.mx", firstName: "Claudia", lastName: "Morales Fuentes", role: Role.EMPLOYEE, hireDate: "2020-08-18", department: "Ventas", manager: "gerenteVentas" },
  { key: "ventasNormal2", email: "ismael.davila@gruponorte.mx", firstName: "Ismael", lastName: "Dávila Ochoa", role: Role.EMPLOYEE, hireDate: "2022-02-14", department: "Ventas", manager: "gerenteVentas" },

  // Operaciones (4 empleados)
  { key: "operAniversario", email: "adriana.villegas@gruponorte.mx", firstName: "Adriana", lastName: "Villegas Marroquín", role: Role.EMPLOYEE, hireDate: "2022-10-08", department: "Operaciones", manager: "gerenteOperaciones" }, // caso "aniversario este mes" (4 años)
  { key: "operCancelada", email: "esteban.zamora@gruponorte.mx", firstName: "Esteban", lastName: "Zamora Quintero", role: Role.EMPLOYEE, hireDate: "2020-01-15", department: "Operaciones", manager: "gerenteOperaciones" },
  { key: "operNormal2", email: "lucia.palacios@gruponorte.mx", firstName: "Lucía", lastName: "Palacios Benítez", role: Role.EMPLOYEE, hireDate: "2023-09-25", department: "Operaciones", manager: "gerenteOperaciones" },
  { key: "operNormal3", email: "diego.montoya@gruponorte.mx", firstName: "Diego", lastName: "Montoya Salazar", role: Role.EMPLOYEE, hireDate: "2018-12-03", department: "Operaciones", manager: "gerenteOperaciones" },

  // Finanzas (4 empleados)
  { key: "finNormal1", email: "karla.espinoza@gruponorte.mx", firstName: "Karla", lastName: "Espinoza Dávila", role: Role.EMPLOYEE, hireDate: "2017-10-16", department: "Finanzas", manager: "gerenteFinanzas" },
  { key: "finNormal2", email: "jonathan.resendiz@gruponorte.mx", firstName: "Jonathan", lastName: "Reséndiz Cantú", role: Role.EMPLOYEE, hireDate: "2021-11-29", department: "Finanzas", manager: "gerenteFinanzas" },
  { key: "finNormal3", email: "paola.trevino@gruponorte.mx", firstName: "Paola", lastName: "Treviño Guerra", role: Role.EMPLOYEE, hireDate: "2024-03-08", department: "Finanzas", manager: "gerenteFinanzas" },
  { key: "finNormal4", email: "hector.olivares@gruponorte.mx", firstName: "Héctor", lastName: "Olivares Fonseca", role: Role.EMPLOYEE, hireDate: "2016-07-19", department: "Finanzas", manager: "gerenteFinanzas" },
];

async function main() {
  // 1. Limpieza (hijo -> padre) para que el seed sea repetible sin duplicados.
  await prisma.requestEvent.deleteMany();
  await prisma.balanceAdjustment.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.holiday.deleteMany();
  await prisma.leaveType.deleteMany();
  await prisma.user.deleteMany();
  await prisma.department.deleteMany();

  // 2. Departamentos.
  const departmentsByName = new Map<string, string>();
  for (const name of DEPARTMENTS) {
    const dept = await prisma.department.create({ data: { name } });
    departmentsByName.set(name, dept.id);
  }

  // 3. Tipos de permiso.
  const leaveTypesByCode = new Map<string, string>();
  for (const lt of LEAVE_TYPES) {
    const created = await prisma.leaveType.create({
      data: {
        code: lt.code,
        name: lt.name,
        countsAgainstVacationBalance: lt.countsAgainstVacationBalance,
      },
    });
    leaveTypesByCode.set(lt.code, created.id);
  }

  // 4. Festivos 2026-2027.
  await prisma.holiday.createMany({
    data: HOLIDAYS_DATA.map((h) => ({ date: d(h.date), name: h.name })),
  });

  // 5. Usuarios (orden: director -> HR/gerentes -> empleados, así el manager
  // ya existe en la base cuando se crea cada fila siguiente).
  const passwordHash = await hashPassword("Demo1234!");
  const usersByKey = new Map<string, { id: string }>();
  for (const u of USERS) {
    const created = await prisma.user.create({
      data: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        hireDate: d(u.hireDate),
        departmentId: departmentsByName.get(u.department)!,
        managerId: u.manager ? usersByKey.get(u.manager)!.id : null,
      },
    });
    usersByKey.set(u.key, { id: created.id });
  }

  const userId = (key: string) => usersByKey.get(key)!.id;

  async function addEvent(
    leaveRequestId: string,
    action: RequestEventAction,
    actorKey: string | null,
    at: string,
    note?: string,
  ) {
    await prisma.requestEvent.create({
      data: {
        leaveRequestId,
        actorId: actorKey ? userId(actorKey) : null,
        action,
        note,
        createdAt: dt(at),
      },
    });
  }

  async function createLeaveRequest(opts: {
    requester: string;
    leaveType: string;
    start: string;
    end: string;
    status: LeaveRequestStatus;
    createdAt: string;
    decider?: string;
    decidedAt?: string;
    decisionNote?: string;
    reason?: string;
    lastUpdateAt: string;
  }) {
    const businessDays = countBusinessDays(d(opts.start), d(opts.end), HOLIDAY_DATES);
    const request = await prisma.leaveRequest.create({
      data: {
        requesterId: userId(opts.requester),
        leaveTypeId: leaveTypesByCode.get(opts.leaveType)!,
        startDate: d(opts.start),
        endDate: d(opts.end),
        businessDays,
        status: opts.status,
        reason: opts.reason,
        deciderId: opts.decider ? userId(opts.decider) : null,
        decidedAt: opts.decidedAt ? dt(opts.decidedAt) : null,
        decisionNote: opts.decisionNote,
        createdAt: dt(opts.createdAt),
        updatedAt: dt(opts.lastUpdateAt),
      },
    });
    return request.id;
  }

  // 6. Solicitudes + su historial de auditoría.
  // Hoy = 2026-10-23. Ningún timestamp usa el default now(): createdAt de cada
  // solicitud pasada va unas semanas antes de su startDate; en las solicitudes
  // futuras, createdAt va unas semanas antes de HOY (el envío ya ocurrió).

  // #1 — Vacaciones de empleado@demo.com, 2026-07-06 a 07-10: lun,mar,mié,jue,vie
  // sin festivo en el rango => 5 días hábiles. APPROVED por jefe@demo.com.
  const r1 = await createLeaveRequest({
    requester: "empleadoDemo",
    leaveType: "VAC",
    start: "2026-07-06",
    end: "2026-07-10",
    status: "APPROVED",
    createdAt: "2026-06-15T10:00:00",
    decider: "jefeTec",
    decidedAt: "2026-06-18T16:00:00",
    reason: "Viaje familiar programado con anticipación.",
    lastUpdateAt: "2026-06-18T16:00:00",
  });
  await addEvent(r1, RequestEventAction.CREATED, "empleadoDemo", "2026-06-15T10:00:00");
  await addEvent(r1, RequestEventAction.APPROVED, "jefeTec", "2026-06-18T16:00:00");

  // #2 — Vacaciones de Rodrigo (Tecnología), 2026-09-14 a 09-18: lun,mar,jue,vie
  // (16-sep es festivo) => 4 días hábiles. REJECTED por jefe@demo.com.
  const r2 = await createLeaveRequest({
    requester: "tecNormal1",
    leaveType: "VAC",
    start: "2026-09-14",
    end: "2026-09-18",
    status: "REJECTED",
    createdAt: "2026-08-25T09:30:00",
    decider: "jefeTec",
    decidedAt: "2026-08-28T15:00:00",
    decisionNote: "El equipo ya tiene cobertura limitada esa semana por otras vacaciones aprobadas.",
    reason: "Viaje personal.",
    lastUpdateAt: "2026-08-28T15:00:00",
  });
  await addEvent(r2, RequestEventAction.CREATED, "tecNormal1", "2026-08-25T09:30:00");
  await addEvent(
    r2,
    RequestEventAction.REJECTED,
    "jefeTec",
    "2026-08-28T15:00:00",
    "El equipo ya tiene cobertura limitada esa semana por otras vacaciones aprobadas.",
  );

  // #3 — Vacaciones de Claudia (Ventas), 2026-08-03 a 08-07: lun-vie sin festivo
  // => 5 días hábiles. APPROVED por la gerente de Ventas y luego CANCELLED por
  // la propia Claudia; el decider_id conserva el id de la gerente (no se toca).
  const r3 = await createLeaveRequest({
    requester: "ventasCancelada",
    leaveType: "VAC",
    start: "2026-08-03",
    end: "2026-08-07",
    status: "CANCELLED",
    createdAt: "2026-07-13T11:00:00",
    decider: "gerenteVentas",
    decidedAt: "2026-07-15T14:00:00",
    reason: "Viaje personal, cancelado después por cambio de planes.",
    lastUpdateAt: "2026-07-28T09:00:00",
  });
  await addEvent(r3, RequestEventAction.CREATED, "ventasCancelada", "2026-07-13T11:00:00");
  await addEvent(r3, RequestEventAction.APPROVED, "gerenteVentas", "2026-07-15T14:00:00");
  await addEvent(r3, RequestEventAction.CANCELLED, "ventasCancelada", "2026-07-28T09:00:00");

  // #4 — Permiso con goce del Director General, 2026-05-18 (lunes, no festivo)
  // => 1 día hábil. El Director no tiene jefe, así que decide un HR.
  const r4 = await createLeaveRequest({
    requester: "director",
    leaveType: "PERM_GOCE",
    start: "2026-05-18",
    end: "2026-05-18",
    status: "APPROVED",
    createdAt: "2026-04-28T09:00:00",
    decider: "rh1",
    decidedAt: "2026-04-30T12:00:00",
    reason: "Compromiso personal de un día.",
    lastUpdateAt: "2026-04-30T12:00:00",
  });
  await addEvent(r4, RequestEventAction.CREATED, "director", "2026-04-28T09:00:00");
  await addEvent(r4, RequestEventAction.APPROVED, "rh1", "2026-04-30T12:00:00");

  // #5 — Día personal de Esteban (Operaciones), 2026-09-21 (lunes, no festivo)
  // => 1 día hábil. Cancelada por el propio empleado antes de que alguien
  // decida: deciderId y decidedAt quedan null.
  const r5 = await createLeaveRequest({
    requester: "operCancelada",
    leaveType: "PERSONAL",
    start: "2026-09-21",
    end: "2026-09-21",
    status: "CANCELLED",
    createdAt: "2026-09-08T08:30:00",
    reason: "Trámite personal.",
    lastUpdateAt: "2026-09-10T09:00:00",
  });
  await addEvent(r5, RequestEventAction.CREATED, "operCancelada", "2026-09-08T08:30:00");
  await addEvent(r5, RequestEventAction.CANCELLED, "operCancelada", "2026-09-10T09:00:00");

  // #6 — Vacaciones del gerente de Finanzas, 2026-06-01 a 06-05: lun-vie sin
  // festivo => 5 días hábiles. APPROVED por el Director.
  const r6 = await createLeaveRequest({
    requester: "gerenteFinanzas",
    leaveType: "VAC",
    start: "2026-06-01",
    end: "2026-06-05",
    status: "APPROVED",
    createdAt: "2026-05-11T10:00:00",
    decider: "director",
    decidedAt: "2026-05-13T11:00:00",
    reason: "Descanso de mitad de año.",
    lastUpdateAt: "2026-05-13T11:00:00",
  });
  await addEvent(r6, RequestEventAction.CREATED, "gerenteFinanzas", "2026-05-11T10:00:00");
  await addEvent(r6, RequestEventAction.APPROVED, "director", "2026-05-13T11:00:00");

  // #7 — Permiso sin goce de Mauricio (HR), 2026-10-05 a 10-06: lun,mar sin
  // festivo => 2 días hábiles. REJECTED por el Director.
  const r7 = await createLeaveRequest({
    requester: "rh2",
    leaveType: "PERM_SIN_GOCE",
    start: "2026-10-05",
    end: "2026-10-06",
    status: "REJECTED",
    createdAt: "2026-09-21T09:00:00",
    decider: "director",
    decidedAt: "2026-09-23T10:00:00",
    decisionNote: "Se requiere cobertura de RH esa semana por el cierre de nómina.",
    reason: "Asunto familiar.",
    lastUpdateAt: "2026-09-23T10:00:00",
  });
  await addEvent(r7, RequestEventAction.CREATED, "rh2", "2026-09-21T09:00:00");
  await addEvent(
    r7,
    RequestEventAction.REJECTED,
    "director",
    "2026-09-23T10:00:00",
    "Se requiere cobertura de RH esa semana por el cierre de nómina.",
  );

  // #8 — Vacaciones futuras de empleado@demo.com, 2026-12-21 a 12-28: lun-jue
  // y el lun-28 (25-dic festivo, 26-27 fin de semana) => 5 días hábiles.
  // PENDING, para que jefe@demo.com la apruebe.
  const r8 = await createLeaveRequest({
    requester: "empleadoDemo",
    leaveType: "VAC",
    start: "2026-12-21",
    end: "2026-12-28",
    status: "PENDING",
    createdAt: "2026-10-12T09:00:00",
    reason: "Vacaciones decembrinas.",
    lastUpdateAt: "2026-10-12T09:00:00",
  });
  await addEvent(r8, RequestEventAction.CREATED, "empleadoDemo", "2026-10-12T09:00:00");

  // #9 — Permiso con goce de Sofía (Tecnología), 2026-11-16 a 11-17: el 16 es
  // festivo (Revolución), así que solo el 17 cuenta => 1 día hábil. PENDING.
  const r9 = await createLeaveRequest({
    requester: "tecNormal2",
    leaveType: "PERM_GOCE",
    start: "2026-11-16",
    end: "2026-11-17",
    status: "PENDING",
    createdAt: "2026-10-15T09:00:00",
    reason: "Puente largo con la familia.",
    lastUpdateAt: "2026-10-15T09:00:00",
  });
  await addEvent(r9, RequestEventAction.CREATED, "tecNormal2", "2026-10-15T09:00:00");

  // #10 — Día personal de Omar (Tecnología), 2026-11-02 (lunes, no festivo)
  // => 1 día hábil. PENDING.
  const r10 = await createLeaveRequest({
    requester: "tecNormal3",
    leaveType: "PERSONAL",
    start: "2026-11-02",
    end: "2026-11-02",
    status: "PENDING",
    createdAt: "2026-10-19T09:00:00",
    reason: "Trámite personal.",
    lastUpdateAt: "2026-10-19T09:00:00",
  });
  await addEvent(r10, RequestEventAction.CREATED, "tecNormal3", "2026-10-19T09:00:00");

  // #11 — Vacaciones de Daniela (Tecnología, caso "5 años"), 2026-12-14 a
  // 12-18: lun-vie sin festivo => 5 días hábiles. PENDING.
  const r11 = await createLeaveRequest({
    requester: "tec5anios",
    leaveType: "VAC",
    start: "2026-12-14",
    end: "2026-12-18",
    status: "PENDING",
    createdAt: "2026-10-09T09:00:00",
    reason: "Vacaciones de fin de año.",
    lastUpdateAt: "2026-10-09T09:00:00",
  });
  await addEvent(r11, RequestEventAction.CREATED, "tec5anios", "2026-10-09T09:00:00");

  // #12 — Vacaciones de Gustavo (Ventas, caso "1 año"), 2027-01-04 a 01-08:
  // lun-vie sin festivo => 5 días hábiles. Aprobada con anticipación por la
  // gerente de Ventas.
  const r12 = await createLeaveRequest({
    requester: "ventas1anio",
    leaveType: "VAC",
    start: "2027-01-04",
    end: "2027-01-08",
    status: "APPROVED",
    createdAt: "2026-10-01T09:00:00",
    decider: "gerenteVentas",
    decidedAt: "2026-10-03T11:00:00",
    reason: "Vacaciones de año nuevo con la familia.",
    lastUpdateAt: "2026-10-03T11:00:00",
  });
  await addEvent(r12, RequestEventAction.CREATED, "ventas1anio", "2026-10-01T09:00:00");
  await addEvent(r12, RequestEventAction.APPROVED, "gerenteVentas", "2026-10-03T11:00:00");

  // #13 — Vacaciones de Adriana (Operaciones, caso "aniversario este mes"),
  // 2027-02-01 a 02-05: el 1-feb-2027 es festivo (Constitución), quedan
  // mar,mié,jue,vie => 4 días hábiles. PENDING.
  const r13 = await createLeaveRequest({
    requester: "operAniversario",
    leaveType: "VAC",
    start: "2027-02-01",
    end: "2027-02-05",
    status: "PENDING",
    createdAt: "2026-10-20T09:00:00",
    reason: "Viaje de aniversario de bodas.",
    lastUpdateAt: "2026-10-20T09:00:00",
  });
  await addEvent(r13, RequestEventAction.CREATED, "operAniversario", "2026-10-20T09:00:00");

  // 7. Ajustes de saldo: solo CARRYOVER y MANUAL_CORRECTION, ningún ACCRUAL
  // (los días por antigüedad salen de hireDate + la tabla de la LFT, no de aquí).
  await prisma.balanceAdjustment.create({
    data: {
      userId: userId("empleadoDemo"),
      leaveTypeId: null,
      type: BalanceAdjustmentType.CARRYOVER,
      days: 3,
      reason: "Saldo de vacaciones no disfrutado del año anterior, autorizado para arrastre.",
      effectiveDate: d("2026-02-01"),
      grantedById: userId("rh1"),
      createdAt: dt("2026-01-05T09:00:00"),
    },
  });

  await prisma.balanceAdjustment.create({
    data: {
      userId: userId("tec5anios"),
      leaveTypeId: null,
      type: BalanceAdjustmentType.MANUAL_CORRECTION,
      days: -2,
      reason: "Corrección: se había registrado un día personal de más en el sistema anterior.",
      effectiveDate: d("2026-09-01"),
      grantedById: userId("rh2"),
      createdAt: dt("2026-09-02T09:00:00"),
    },
  });

  // 8. Resumen final.
  const counts = {
    departments: await prisma.department.count(),
    users: await prisma.user.count(),
    leaveTypes: await prisma.leaveType.count(),
    holidays: await prisma.holiday.count(),
    leaveRequests: await prisma.leaveRequest.count(),
    requestEvents: await prisma.requestEvent.count(),
    balanceAdjustments: await prisma.balanceAdjustment.count(),
  };
  console.log("Seed de Grupo Norte completado:");
  console.table(counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
