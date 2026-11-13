# Leave Manager

Sistema web de solicitudes de vacaciones y permisos para empresas.
Proyecto de portafolio: debe verse y funcionar como software profesional.

## Stack
- Backend: Node 22 + Express + TypeScript + Prisma + Zod (carpeta `server/`)
- Frontend: React + Vite + TypeScript + React Router + TanStack Query (carpeta `client/`)
- Base de datos: PostgreSQL 17 en Docker Compose
- Tests: Vitest + Supertest

## Comandos
- Levantar la base de datos: `docker compose up -d`
- Ver estado de contenedores: `docker compose ps`
- Consola de Postgres: `docker compose exec db psql -U leave_admin -d leave_manager`

## Roles
- EMPLOYEE: pide vacaciones y permisos, ve su saldo y sus solicitudes.
- MANAGER: aprueba o rechaza solicitudes de su equipo.
- HR: administra empleados, departamentos, festivos y saldos.

## Reglas de negocio
- Días de vacaciones según la Ley Federal del Trabajo (reforma 2023):
  año 1 = 12, +2 por año hasta 20 en el año 5; después +2 cada 5 años.
- Solo cuentan días hábiles: se excluyen sábados, domingos y festivos.
- No se puede pedir más días que el saldo disponible.
- Un usuario no puede tener solicitudes con fechas encimadas.
- Un manager no aprueba sus propias solicitudes.
- Toda acción sobre una solicitud se guarda en el historial (auditoría).
- `decider_id` solo se usa para aprobaciones/rechazos (acción de un MANAGER/HR).
  Cuando el propio empleado cancela su solicitud, la cancelación se registra
  en `request_events` con el empleado como actor y `decider_id` no se modifica
  — así se evita violar el constraint `chk_leave_requests_decider_not_requester`.
  El CHECK `chk_leave_requests_decision_matches_status` lo refuerza: APPROVED/REJECTED
  tienen `decider_id` y `decided_at`; PENDING no tiene ninguno; CANCELLED tiene ambos
  (se aprobó y luego se canceló) o ninguno (se canceló estando pendiente).

## Aprobación, rechazo y cancelación
- Decide (aprueba o rechaza) el jefe directo activo del solicitante (`managerId`). Si
  no tiene jefe o su jefe está inactivo, decide cualquier usuario HR activo. Nadie
  decide sus propias solicitudes.
- Ver el detalle de una solicitud: el solicitante, quien puede decidirla, quien ya la
  decidió y cualquier HR. Para cualquier otro se responde 404 (no 403) para no revelar
  que existe; la visibilidad se comprueba antes de abrir la transacción, así un id
  oculto y uno inexistente cuestan lo mismo y nadie bloquea filas ajenas.
- Decisión consciente (auditoría): quien ya decidió una solicitud la sigue viendo
  aunque ya no sea el jefe del solicitante (p. ej. si el empleado cambió de equipo),
  incluidos los eventos posteriores como una cancelación.
- Cancelar: solo el solicitante.
- Máquina de estados (`server/src/domain/leave-request-state.ts`):
  PENDING → APPROVED | REJECTED | CANCELLED; APPROVED → CANCELLED solo si
  `startDate` es posterior a "hoy" (en `APP_TIMEZONE`); REJECTED y CANCELLED son finales.
- Rechazar exige una nota (el empleado merece saber por qué); aprobar y cancelar no.
- Al aprobar se revalida el saldo del periodo del `startDate` (debe quedar
  `available >= 0`), por si RH hizo un ajuste negativo desde que se creó. Si el periodo
  quedó negativo, ninguna PENDING de ese periodo se puede aprobar hasta que se rechace
  o cancele alguna (o RH corrija el ajuste).
- Solicitudes PENDING cuyo `startDate` ya llegó (`startDate <= hoy`): se pueden
  decidir tarde y aparecen primero en `pending-approvals` con `isOverdue: true`. No
  hay vencimiento automático: ya reservan su saldo, en la práctica el empleado pudo
  haber faltado con aprobación verbal, y un rechazo automático falsearía la auditoría.
- Concurrencia: toda operación que cambie saldo o estado bloquea primero la fila del
  usuario solicitante (`lockUser`) y después la de la solicitud (`lockLeaveRequest`),
  en ese orden para evitar deadlocks (`server/src/db/locks.ts`); además el UPDATE va
  condicionado al estado leído.

## Saldo de vacaciones (periodo y fechas)
- El saldo es por periodo de aniversario a aniversario (no año calendario).
- Una solicitud cuenta en el periodo donde cae su `startDate`; un ajuste cuenta
  en el periodo donde cae su `effectiveDate`.
- Quien aún no cumple su primer aniversario tiene su periodo actual desde
  `hireDate` hasta el día antes de su primer aniversario, con 0 días ganados.
- El `startDate` de una solicitud nueva solo puede caer en el periodo actual o en
  el siguiente (calculados con "hoy" en `APP_TIMEZONE`); más lejos se rechaza con
  400. Así nadie aparta fechas con años de anticipación contra días que la LFT aún
  no otorga.
- Una solicitud que cruza dos periodos se descuenta completa del periodo donde
  empieza (su `startDate`); no se reparte entre periodos.
- Los días no usados NO pasan automáticamente al siguiente periodo: el saldo se
  reinicia en cada aniversario y el remanente solo pasa si RH crea un ajuste
  `CARRYOVER`.
- Las fechas sin hora (`@db.Date`) se tratan siempre como medianoche UTC; todo
  cálculo usa métodos `getUTC*`/`setUTC*`/`Date.UTC`, nunca los locales
  (`getDate()`, `getDay()`, etc.), para evitar errores de un día por zona
  horaria del servidor.
- Aniversario de ingresos el 29 de febrero: en años no bisiestos se cumple el
  28 de febrero, no el 1 de marzo (Art. 18 LFT: en caso de duda se aplica la
  interpretación más favorable al trabajador, y con el 28 de febrero cumple su
  año un día antes).

## Convenciones
- TypeScript en modo estricto; evitar `any`.
- Validar toda entrada de la API con Zod.
- Nunca poner secretos en el código; usar variables de entorno (`.env`).
- Commits con Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Código, nombres de variables y commits en inglés.

## Forma de trabajar
- Estoy aprendiendo: explica brevemente qué hiciste y por qué.
- Trabaja en pasos pequeños y verificables.
- Pregunta antes de instalar dependencias nuevas o cambiar la estructura del proyecto.
- Toda migración nueva se crea con `npx prisma migrate dev --create-only` y se revisa
  con el agente db-architect ANTES de correr cualquier test: el `globalSetup` de los
  tests de integración corre `prisma migrate deploy` y aplica a `leave_manager_test`
  cualquier migración que exista en la carpeta, revisada o no.

## Pendientes técnicos
- Configurar CORS (`cors()` con `credentials: true` y origin explícito) cuando el
  cliente (`client/`, Vite) empiece a consumir la API con cookies desde otro origen.
- Configurar `app.set("trust proxy", ...)` antes de desplegar detrás de un proxy o
  load balancer, para que `express-rate-limit` identifique la IP real del cliente.
- Migrar `DATABASE_URL` (hoy leído directo de `process.env` en `server/src/db/prisma.ts`)
  al schema de Zod de `server/src/config/env.ts`, por consistencia con el resto de las
  variables de entorno.
- Guardar en `leave_requests` si la solicitud descontaba saldo al crearla (copia de
  `countsAgainstVacationBalance`), o impedir editar ese campo en tipos que ya tienen
  solicitudes; hoy el saldo lo lee del tipo en el momento del cálculo, así que
  cambiarlo altera saldos hacia atrás. Decidirlo antes del CRUD de tipos para HR.
- Usar el mismo bloqueo por usuario (`lockUser` de `server/src/db/locks.ts`, dentro de
  la transacción) en los ajustes de saldo de HR y en cualquier futura modificación de
  solicitudes; el bloqueo solo serializa a quienes lo toman. (Crear, aprobar, rechazar
  y cancelar ya lo usan.)
- Paginación de `GET /api/leave-requests/mine` y de
  `GET /api/leave-requests/pending-approvals` (`take`/`cursor` o filtro por periodo).
- Al hacer el CRUD de empleados (HR):
  - Validar `managerId !== id`: con un usuario como su propio jefe, `hasActiveManager`
    da `true` y nadie puede decidir sus solicitudes.
  - Validar que `managerId` apunte a un usuario MANAGER o HR (hoy `canDecide` no mira
    el rol del jefe directo).
  - Mostrar a HR las PENDING que nadie puede decidir (p. ej. el único HR activo sin
    jefe activo).
- En el detalle, avisar cuando el saldo del periodo está negativo: hoy
  `permissions.canApprove` sale `true` aunque aprobar vaya a responder 422.
- LFT pendiente de aplicar: Art. 78 (al menos 12 días continuos si el trabajador lo
  pide) y Art. 81 (las vacaciones se otorgan dentro de los 6 meses siguientes al
  aniversario).
- Prisma 7 lanza en paralelo las subconsultas de relaciones de una misma operación;
  dentro de una transacción interactiva eso dispara el aviso de `pg` "client.query()
  when the client is already executing a query", que en pg@9 será un error. Lo
  disparaba cargar el detalle completo (eventos, personas) dentro de la transacción;
  por eso dentro de transacciones se leen solo los campos necesarios y el detalle se
  carga después del commit. Revisar antes de actualizar `pg` a la v9.