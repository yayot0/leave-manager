# Leave Manager

Sistema web de solicitudes de vacaciones y permisos para empresas.
Proyecto de portafolio: debe verse y funcionar como software profesional.

## Stack
- Backend: Node 22 + Express + TypeScript + Prisma + Zod (carpeta `server/`)
- Frontend: React 19 + Vite + TypeScript + React Router 8 (modo Data) + TanStack Query,
  con Tailwind CSS v4 y shadcn/ui sobre Base UI (carpeta `client/`)
- Base de datos: PostgreSQL 17 en Docker Compose
- Tests: Vitest + Supertest (server); Vitest + React Testing Library + MSW (client)

## Comandos
- Levantar la base de datos: `docker compose up -d`
- Ver estado de contenedores: `docker compose ps`
- Consola de Postgres: `docker compose exec db psql -U leave_admin -d leave_manager`

Frontend (desde `client/`):
- Desarrollo: `npm run dev` (http://localhost:5173; necesita la API corriendo en :3000
  con `cd server && npm run dev`)
- Tests: `npm test` (una vez) o `npm run test:watch`
- Tipos: `npm run typecheck` · Lint: `npm run lint` · Build: `npm run build`
- Agregar un componente de shadcn/ui: `npx shadcn@latest add <componente>`

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

## Crear solicitud y vista previa
- `POST /api/leave-requests` y `GET /api/leave-requests/preview?leaveTypeId=&startDate=&endDate=`
  usan la MISMA validación (`server/src/modules/leave-requests/new-request-validation.ts`),
  para que nunca se contradigan. Dos fases:
  1. `evaluateRequestInput`: fecha pasada, fuera del periodo actual/siguiente, tipo inválido
     o inactivo, 0 días hábiles, más días hábiles que el máximo del tipo. El POST la corre
     antes de la transacción.
  2. `evaluateAgainstUserState`: encimadas y saldo del periodo del `startDate`. El POST la
     corre dentro de la transacción, después de `lockUser`.
- Cada problema tiene un `code` (`START_IN_PAST`, `START_TOO_FAR`, `INVALID_LEAVE_TYPE`,
  `NO_BUSINESS_DAYS`, `EXCEEDS_TYPE_LIMIT` → 400; `OVERLAP` → 409; `INSUFFICIENT_BALANCE` → 422).
  El POST lanza el
  primero y su error trae `{ error, code }`; el preview responde 200 con todos en
  `problems` y `canSubmit`. Los datos mal formados son 400 de Zod en ambos (el query del
  preview es `.strict()`: solo esos tres parámetros).
- El preview no escribe ni bloquea: es una foto; el POST revalida todo bajo el lock. Con un
  problema de fecha no calcula saldo (`balance: null`, sería de otro periodo) pero sí revisa
  encimadas; con tipo inválido se salta la fase 2. En ambos casos el POST ya habría fallado
  en la fase 1, así que `canSubmit` sigue coincidiendo.
- Toda regla nueva para crear solicitudes va en ese módulo, nunca solo en el POST.
- `EXCEEDS_TYPE_LIMIT`: cada tipo tiene un máximo opcional de días hábiles por solicitud
  (`maxBusinessDaysPerRequest`, null = sin límite; fines de semana y festivos no cuentan). Es
  una regla de CREACIÓN: bajar el máximo no toca las solicitudes existentes (se pueden aprobar).
  Seed: Vacaciones sin límite (el saldo ya la acota y el Art. 78 LFT pide al menos 12 días
  continuos si se piden), Permiso con goce 5, sin goce 10, Día personal 1 (política de empresa).
- La solicitud guarda una copia de `countsAgainstVacationBalance` de su tipo al crearse (columna
  `leave_requests.counts_against_vacation_balance`, sin DEFAULT: el código siempre la escribe).
  Saldo, el 422 al aprobar y `requesterBalance` usan esa copia, nunca el valor actual del tipo,
  así editar un tipo nunca cambia saldos hacia atrás. La API la expone en `mine`, el detalle y
  `pending-approvals`, y el cliente la usa ("Descuenta de tus vacaciones", texto de cancelar).
- `GET /api/leave-requests/mine` (y el POST) incluyen `permissions.canCancel`, calculado con
  `transition()`; el cliente no reimplementa la máquina de estados.

## Saldo del solicitante al decidir
- El detalle (`GET /api/leave-requests/:id`) trae `requesterBalance` para quien puede decidir
  la solicitud en ese momento (PENDING + `canDecide`) y solo si el tipo descuenta vacaciones;
  para cualquier otro (el solicitante, HR que solo mira, el decisor anterior) es `null`. Va en
  el detalle y no en un endpoint aparte para reutilizar la misma comprobación de visibilidad
  (404) y permisos, y porque el cliente lo refresca junto con el detalle tras cada acción.
- Se calcula con `getVacationBalance` para el periodo del `startDate`:
  `availableAfterApproval = available` (una PENDING ya reserva sus días),
  `availableWithoutRequest = available + businessDays` (lo que queda si se rechaza) y
  `blocksApproval = available < 0`, la misma condición del 422 al aprobar. El cliente oculta
  "Aprobar" con `blocksApproval` y muestra el aviso; `permissions.canApprove` sigue siendo solo
  autorización (coincide con `pending-approvals`).

## Catálogos de RH (Fase RH-A)
- Todo `/api/hr` es solo para HR: `requireAuth` + `requireRole("HR")` a nivel de router (401 sin
  sesión, 403 a cualquier otro rol). Entrada con Zod `.strict()`; los 409 traen `code`
  (`DUPLICATE_NAME`, `DUPLICATE_CODE`, `DUPLICATE_DATE`, `DEPARTMENT_HAS_EMPLOYEES`).
- Departamentos: listar (con `employeeCount`, activos e inactivos), crear, renombrar y borrar
  SOLO si no tiene ningún empleado (activo o inactivo); si no, 409. No se desactivan: así la RH-B
  no tiene que filtrar departamentos inactivos. La FK `users.department_id` es `RESTRICT`
  (antes `SET NULL`) como segunda defensa.
- Tipos de permiso: listar (incluidos inactivos, con `requestCount`), crear, editar y
  desactivar/reactivar; nunca se borran. Editables: `name`, `countsAgainstVacationBalance`,
  `maxBusinessDaysPerRequest`, `isActive`. El `code` NO se edita (identificador estable del seed,
  integraciones y bitácora; mandarlo en el PATCH es 400). Todo cambio aplica solo a solicitudes
  nuevas (por la copia y porque el límite es regla de creación). Un tipo inactivo no se ofrece
  (`INVALID_LEAVE_TYPE`), pero sus solicitudes existentes se pueden decidir y cancelar.
- Art. 78 LFT: un tipo que descuenta vacaciones solo admite máximo `null` o `>= 12`
  (`LIMIT_BELOW_LFT_MINIMUM`, 400). Se evalúa sobre el tipo resultante (fila + cambio) y solo
  cuando cambia "descuenta" o el máximo, así un registro viejo que no cumple aún se puede
  renombrar o desactivar. Es regla del servicio, no CHECK de la base.
- Concurrencia optimista en el PATCH de tipos: el cliente manda `expectedUpdatedAt` (el
  `updatedAt` que cargó) y solo los campos que cambió; si alguien guardó antes, 409
  `STALE_DATA` sin escribir ni registrar. Usar el mismo patrón en RH-B (empleados, saldos).
- Nombres sin caracteres de control en ninguna posición (Zod `\p{Cc}`). Festivos solo de 2000 a
  2100, igual que el listado por año.
- Nombres únicos sin distinguir mayúsculas (`uq_*_name_lower` con `lower(name)`) y sin espacios
  en los extremos (CHECK); el servicio revisa antes con el mismo criterio (SQL con `lower()`, no
  `mode: "insensitive"`) y además mapea la violación de unicidad a 409.
- Festivos: listar por año, agregar y quitar. `businessDays` se fija al crear la solicitud y NO
  se recalcula: si se agrega un festivo, las solicitudes activas que lo cruzan quedan con un día
  de más (siguen descontando un día que ya no es hábil); si se quita, con uno de menos.
  `GET /api/hr/holidays/impact?date=` (y la respuesta del POST/DELETE) da
  `{ affectedRequests, breakdown: { countingBalance, notCountingBalance, past, upcoming } }`:
  cuántas PENDING/APPROVED cruzan la fecha, cuántas descuentan saldo según su COPIA y cuántas ya
  terminaron (`endDate` antes de hoy en `APP_TIMEZONE`) o están en curso/por venir. Todo 0 si cae
  en sábado o domingo (nunca contaron). El diálogo lo avisa antes de confirmar; las que descuentan
  (también las ya terminadas, que siguen sumando en su periodo) pueden necesitar un ajuste.
- Bitácora de RH (`hr_audit_logs`): quién (`actor_id`), sobre qué (`entity_type`, `entity_id`
  sin FK porque la entidad puede borrarse), qué acción (`CREATED`, `UPDATED`, `DEACTIVATED`,
  `REACTIVATED`, `DELETED`), foto `before`/`after` en JSON (campos en lista blanca, fechas ISO,
  NUNCA secretos como `passwordHash`) y cuándo. Se escribe con `recordHrAudit(tx, ...)` en la
  MISMA transacción que el cambio (un error no deja fila). Inmutable: triggers rechazan UPDATE,
  DELETE y TRUNCATE (este último salvo `set_config('app.allow_audit_truncate','on', true)`, que
  solo usan `resetDb` y el seed); CHECKs exigen que before/after coincidan con la acción y sean
  objetos JSON. Para guardar NULL en un `Json?` usar `Prisma.DbNull`, no `null`.
- Antes de leer la foto `before`, se bloquea la fila (`lockDepartment`/`lockLeaveType` con
  `FOR NO KEY UPDATE`, para no frenar inserts que la referencian; `lockHoliday`).
- Un cambio sin diferencias (mismo nombre, PATCH con los mismos valores) no escribe ni registra.

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

## Convenciones del frontend (`client/`)
- Mismo origen, sin CORS: en desarrollo el proxy de Vite (`vite.config.ts`) reenvía
  `/api` a `localhost:3000`; el navegador solo ve `localhost:5173`, así que no hay
  peticiones cross-origin y la cookie de sesión viaja como first-party. En producción
  se mantiene un solo origen (ver "Pendientes técnicos").
- Todo acceso a la API pasa por `src/api/client.ts` (`apiFetch`): manda la cookie,
  parsea JSON y lanza `ApiError` con el mensaje de la API. Un 401 limpia la sesión y
  regresa al login (salvo en `POST /auth/login`, donde 401 = credenciales inválidas).
- Los tipos de las respuestas viven en `src/api/types.ts` (espejo de los del server;
  fechas como `string`).
- La sesión sale solo de `GET /api/auth/me` (`useSession` en `src/auth/session.ts`).
  Dentro de las rutas protegidas se usa `useCurrentUser()`. Nada de tokens ni datos de
  sesión en `localStorage`/`sessionStorage`: la sesión vive en la cookie httpOnly.
- Menú y rutas salen de la misma lista (`NAV_ITEMS` en `src/app/navigation.ts`), con
  los roles de cada sección. Ocultar opciones es UX; la seguridad la aplica la API.
- Permisos por ruta con negación por defecto (default deny): `canAccess` normaliza
  mayúsculas y la `/` final, y niega cualquier ruta que no esté en `NAV_ITEMS`.
- Después de login se regresa a `from` solo si es una ruta interna permitida al rol
  (`src/routes/redirect-target.ts`): empieza con `/` y no con `//`, el parser de `URL`
  confirma que es del mismo origen (cubre trucos como `/\t/sitio.com`), no es `/login`
  y el rol puede abrirla. Así se evitan open redirects. Al cerrar sesión a propósito no
  se guarda `from`; solo cuando la sesión expira (401).
- Al cambiar de usuario (login, logout, 401) se cancelan y borran todas las queries
  salvo la de sesión y se vacía la caché de mutaciones (`setSession` en
  `src/auth/session.ts`), para no filtrar datos entre usuarios.
- Rutas de la API con parámetros: escapar cada valor con `encodeURIComponent`
  (p. ej. `` `/leave-requests/${encodeURIComponent(id)}` ``). `new URL` normaliza `../`,
  y un id manipulado podría apuntar a otro endpoint del mismo origen.
- Cada página usa `PageHeading` (su `h1` con `tabIndex={-1}` y el `<title>`); al
  cambiar de ruta `AppLayout` mueve el foco a ese `h1`.
- Fechas (`src/lib/dates.ts`): las fechas sin hora ("YYYY-MM-DD", o `hireDate` con
  `T00:00:00.000Z`) se formatean con `formatDate`/`formatShortDate`/`formatDateRange`, que las
  reconstruyen en medianoche UTC y formatean con `timeZone: "UTC"`. Nunca
  `new Date("2026-03-01")` + formato local: en Monterrey (UTC-6) sale el 28 de febrero. Los
  instantes (`createdAt` de eventos) sí van en la zona del navegador (`formatDateTime`). En los
  formularios las fechas se quedan como strings del `input type="date"`. Los tests corren con
  `TZ=America/Monterrey` (`vite.config.ts`), así que detectan el error.
- Números (`src/lib/numbers.ts`): negativos con el signo menos real "−", no con guion.
- Ninguna regla de negocio en el cliente: días hábiles, saldos y si algo se puede cancelar
  vienen de la API (preview, `permissions`). Para saber qué falló, usar `ApiError.code`, nunca
  interpretar el texto del mensaje.
- Query keys en `src/api/query-keys.ts`; todo lo de solicitudes bajo `["leave-requests"]`.
  Tras crear o cancelar, `invalidateLeaveData` (`src/hooks/leave-requests.ts`) refresca lista,
  detalles, aprobaciones y saldo sin esperar (no bloquea la navegación), y solo marca como
  viejas las previews (`refetchType: "none"`): recalcular la del formulario recién enviado
  mostraría "se encima" con la solicitud que se acaba de crear.
- Rutas que no van en el menú (p. ej. `/solicitudes/:id`) van en `NAV_ITEMS` con
  `showInMenu: false`; `canAccess` las empata con `matchPath` (un segmento por parámetro,
  primero las estáticas) y sigue negando por defecto. Rutas con id: `requestDetailPath(id)`.
- Los diálogos de acción (`CancelRequestDialog`, `DecisionDialog` para aprobar/rechazar) siguen
  montados mientras están abiertos o cerrándose aunque su permiso pase a `false`, para que el
  error siga visible y el foco vaya al `h1` en vez de a `<body>` (`useStickyDialog` en
  `src/hooks/use-sticky-dialog.ts`). Tras 403/404/409/422 se refresca todo detrás del diálogo
  (`useRequestActionMutation`); el diálogo muestra textos propios, no el mensaje de la API. El
  saldo insuficiente al aprobar se reconoce por `code: "INSUFFICIENT_BALANCE"`, no por el 422.
  Tras un 409 (`isConflictError`) reintentar nunca funcionaría: el botón de confirmar y la nota
  se deshabilitan y el foco pasa a "Volver", la única salida.
- El detalle se sigue mostrando mientras haya `data`, aunque un refresco falle (p. ej. 404
  porque el empleado cambió de jefe): así no se desmonta el diálogo con su error. En ese caso se
  avisa que los datos son viejos y no se ofrece ninguna acción.
- Avisos fijos (saldo negativo, vencida) con `role={undefined}` en `Alert`: `role="alert"` es
  solo para mensajes que aparecen tras una acción. Los mensajes de éxito van en una región
  `role="status"` siempre montada.
- Rechazar exige nota también en el cliente (vacía o solo espacios no se envía).
- El contador de "Aprobaciones" del menú usa la misma query que la página
  (`queryKeys.pendingApprovals`), así que `invalidateLeaveData` refresca ambos; solo se pide
  para roles que pueden abrir Aprobaciones.
- "Volver" del detalle: a Aprobaciones si se llegó desde ahí (`FROM_APPROVALS_STATE` como state
  del router, nunca una URL) o si la solicitud es de otra persona; si no, a Mis solicitudes.
- Logout a propósito: `useLogout` marca la salida como deliberada y `ProtectedRoute` redirige
  a login sin `from`. No depende del orden entre la navegación de React Router (que es una
  transition) y la actualización de TanStack Query, que no está garantizado.
- Administración (solo HR): `/administracion` es un índice y cada catálogo es una subruta en
  `NAV_ITEMS` con `showInMenu: false` (`/administracion/departamentos`, `/tipos-de-permiso`,
  `/festivos`); cualquier otra `/administracion/...` se niega. `matchNested: true` mantiene
  resaltado "Administración" en el menú en sus subpáginas; `AdminSubnav` enlaza las secciones.
- **Los diálogos de confirmación y de formulario viven FUERA de las filas y listas.** Un diálogo
  dentro de una fila muere con la fila: tras un 404/409 la lista se refresca, la fila desaparece
  y el error nunca se ve (el foco cae a `<body>`). Este bug ya apareció dos veces (4B/4C y RH-A).
  Patrón: `useEntityDialog<T>()` (`src/hooks/use-entity-dialog.ts`) a nivel de página; la fila
  solo tiene un botón que llama `show(entidad)` (con `aria-haspopup="dialog"` y un `aria-label`
  con contexto); el diálogo se monta una vez con `key={session}` (formulario y mutación nuevos en
  cada apertura) y trabaja con la foto de la entidad. `finalFocus` regresa al botón que lo abrió
  si sigue en la página o al `h1`; tras borrar, `markRemoved()` manda el foco al `h1`.
  (`CancelRequestDialog`/`DecisionDialog` conservan `useStickyDialog` porque su botón no vive en
  una fila que pueda desaparecer; uno nuevo en una lista debe usar `useEntityDialog`.)
- Catálogos: crear/editar con `CatalogFormDialog` (un `<form>` en `Dialog`) y confirmar con
  `ConfirmActionDialog` (`AlertDialog`), ambos controlados por `useEntityDialog`. Una sola
  mutación por diálogo (`useSaveDepartment(id?)`, `useSaveLeaveType()`). Los errores con campo
  (`DUPLICATE_*`, `LIMIT_BELOW_LFT_MINIMUM`) van debajo de ese campo según `ApiError.code`
  (`catalogFormError`) y el foco va a ese campo; al validar en el cliente, al primer campo
  inválido. Los demás, en una alerta dentro del diálogo; tras un 404, 409 o `STALE_DATA` solo
  queda "Volver", y ante cualquier error al confirmar el foco pasa a "Volver". Los mensajes de
  éxito van en `ActionStatus` (región `role="status"` siempre montada); un aviso que aparece
  después de abrir el diálogo (el impacto de un festivo) también va en una región `role="status"`
  siempre montada y describe el botón de confirmar (`aria-describedby`). Entradas que llaman a la
  API mientras se escribe (la fecha del festivo) pasan por `useDebouncedValue`. Query keys bajo
  `["hr"]` (el impacto en `["hr","holiday-impact",fecha]`, fuera del prefijo de la lista);
  cambiar un tipo invalida `["leave-types"]` y marca viejas (`refetchType: "none"`) todas las
  de `["leave-requests"]`, que traen su nombre.
- Títulos de sección: `CardTitle` es un `div`; envolver el texto en `<h2>`.
- Textos de la interfaz en español; código en inglés.
- `src/components/ui/` es código generado por shadcn: se puede editar, pero con
  cuidado y solo para adaptarlo (p. ej. traducir textos).
- Tests: con MSW (`src/test/server.ts`), nunca reemplazando `fetch` a mano;
  `renderApp(ruta)` (`src/test/render.tsx`) monta la app completa con las rutas reales.
  Consultar por rol y nombre accesible (`getByRole`, `getByLabelText`).
  `src/test/server.ts` trae respuestas por defecto (saldo, `mine` y `pending-approvals`
  vacías, tipos, preview, catálogos de RH vacíos e impacto 0). Para el detalle usar `mockDetail(...)`: un `http.get(".../:id")`
  suelto también atrapa `/mine` y `/preview` y esconde errores. Para estados de carga, `deferred()` (`src/test/deferred.ts`)
  detiene una respuesta hasta que el test la suelta; para debounces, timers falsos solo de
  `setTimeout`/`clearTimeout`. Fixtures en `src/test/fixtures.ts`.

## Forma de trabajar
- Nunca trabajar directo en `main`: cada cambio va en una rama (`feat/…`, `fix/…`, `docs/…`)
  y se integra con un Pull Request. No hacer push sin que lo pida.
- Todas las respuestas, planes y revisiones (incluidas las de los agentes) van en español.
- Estoy aprendiendo: explica brevemente qué hiciste y por qué.
- Trabaja en pasos pequeños y verificables.
- Pregunta antes de instalar dependencias nuevas o cambiar la estructura del proyecto.
- Toda migración nueva se crea con `npx prisma migrate dev --create-only` y se revisa
  con el agente db-architect ANTES de correr cualquier test: el `globalSetup` de los
  tests de integración corre `prisma migrate deploy` y aplica a `leave_manager_test`
  cualquier migración que exista en la carpeta, revisada o no. Si hay varias migraciones
  seguidas sin revisar, generar el SQL de las siguientes con `prisma migrate diff
  --from-schema <antes> --to-schema <después> --script` (no toca la base) en lugar de aplicar
  la anterior. Después de aplicarlas, correr `npx prisma migrate dev` otra vez y confirmar que
  diga "Already in sync": CHECKs, triggers e índices por expresión (`lower(name)`) no viven en
  `schema.prisma`, así que hay que verificar que Prisma no proponga quitarlos. Documentar en
  `schema.prisma`, junto al modelo, cada constraint agregado a mano.

## Pendientes técnicos
- CORS: no se usa, porque frontend y API comparten origen. Para producción, servir
  ambos bajo un solo dominio con un reverse proxy (Caddy o Nginx): estáticos de
  `client/dist` con fallback a `index.html` y `/api` reenviado a Node. Solo configurar
  `cors()` (`credentials: true` y origin explícito) si algún día se separan los dominios.
  Al configurarlo:
  - Los headers de seguridad del frontend los pone el proxy: `helmet()` solo cubre las
    respuestas de Express (`/api`). El `index.html` necesita su propio
    `Content-Security-Policy` (al menos `default-src 'self'; frame-ancestors 'none'`),
    `Strict-Transport-Security`, `X-Content-Type-Options` y `Referrer-Policy`.
  - El fallback a `index.html` no debe capturar `/api`: `/api/ruta-inexistente` tiene que
    llegar a Node y responder 404 JSON, no HTML con 200.
  - Correr Node con `NODE_ENV=production`; si falta, la cookie sale sin `secure` aunque
    haya HTTPS.
- **Obligatorio antes del despliegue (Fase 6): rate limiting por usuario** en las rutas con
  sesión, empezando por `GET /api/leave-requests/preview` (cada llamada hace ~5 consultas y el
  debounce del cliente no protege contra un script). Usar `express-rate-limit` con
  `keyGenerator` por `req.user.id` (no por IP, así no depende de `trust proxy`), p. ej. ~60
  peticiones/minuto. Hoy solo el login tiene límite.
- Errores con datos estructurados: los mensajes de reglas de negocio traen fechas ISO
  ("…(2026-12-02 a 2026-12-02)", "periodo 2026-03-15 a 2027-03-14") que la UI muestra tal cual,
  mientras el resto usa "2 dic 2026". Solución: que el server devuelva el `code` (ya existe)
  más los datos en campos aparte (p. ej. `{ code: "OVERLAP", overlap: { startDate, endDate } }`,
  `{ code: "INSUFFICIENT_BALANCE", requested, available, period }`), tanto en el error del POST
  como en `problems` del preview, y que el cliente arme el texto con `formatDate`. Mantener
  `error`/`message` en español para otros clientes.
- `BalanceAdjustment.leaveTypeId` existe pero `getVacationBalance` suma todos los ajustes sin
  filtrar por tipo: definir antes del CRUD de ajustes si un ajuste ligado a un tipo que no
  descuenta vacaciones debe afectar el saldo.
- Configurar `app.set("trust proxy", ...)` antes de desplegar detrás de un proxy o
  load balancer, para que `express-rate-limit` identifique la IP real del cliente.
- Migrar `DATABASE_URL` (hoy leído directo de `process.env` en `server/src/db/prisma.ts`)
  al schema de Zod de `server/src/config/env.ts`, por consistencia con el resto de las
  variables de entorno.
- La fase 1 de la creación lee el tipo y los festivos fuera del lock, así que un cambio de RH
  en ese instante no se ve (ventana de milisegundos). La copia se toma del mismo tipo que se
  validó, así que saldo y copia siempre coinciden.
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
- Contador de "Aprobaciones" del menú: hoy solo se refresca al invalidar, al montar o al volver
  el foco a la ventana. Cuando exista el rate limiting por usuario, agregarle `refetchInterval`
  (1–2 min, `refetchIntervalInBackground: false`) para que un jefe con la pestaña abierta vea
  llegar solicitudes nuevas.
- Fase de RH: revisar el "Volver" del detalle (`useBackLink` en `RequestDetailPage`). Hoy toda
  solicitud ajena regresa a Aprobaciones; cuando HR llegue desde otras pantallas (empleados,
  reportes) debe regresar a la de origen (otro valor literal de router state, como
  `FROM_APPROVALS_STATE`).
- **Obligatorio antes del despliegue (Fase 6): roles de base de datos.** La app no debe
  conectarse como dueña de las tablas (hoy `leave_admin`): un dueño puede hacer
  `ALTER TABLE ... DISABLE TRIGGER` y saltarse la inmutabilidad de `hr_audit_logs`. Usar un rol
  dueño solo para migrar y un rol de la app sin TRUNCATE ni ALTER, con solo `SELECT`/`INSERT`
  sobre `hr_audit_logs` (el trigger de TRUNCATE es una defensa extra, no sustituye el permiso).
- RH-B (empleados): los empleados nuevos entran con una contraseña temporal que deben cambiar en
  su primer inicio de sesión (p. ej. `mustChangePassword` en `users`; mientras sea `true` la API
  solo permite cambiar la contraseña y cerrar sesión). La bitácora registrará empleados y ajustes
  (`ALTER TYPE "HrAuditEntity" ADD VALUE` no deja usar el valor nuevo en la misma transacción:
  si un CHECK lo usa, separar en dos migraciones). Las fotos de usuario NUNCA incluyen
  `passwordHash`.
- Festivos: recalcular `businessDays` de las solicitudes activas afectadas al agregar o quitar
  un festivo (hoy solo se avisa con el desglose). Si se hace, en la misma transacción, con evento
  `MODIFIED` y `lockUser`, y decidir qué pasa si quitar un festivo deja un saldo negativo.
- Límite por solicitud esquivable: `EXCEEDS_TYPE_LIMIT` revisa una sola solicitud, así que un
  "Día personal" (máx. 1) se puede pedir lunes, martes y miércoles en tres solicitudes pegadas.
  Solución futura: un tope OPCIONAL de días hábiles por año para cada tipo (p. ej.
  `maxBusinessDaysPerYear`, null = sin tope; definir si "año" es calendario o el periodo de
  aniversario), validado en la fase 2 de `new-request-validation.ts` (dentro del lock, sumando
  PENDING/APPROVED del mismo tipo según la copia) con su propio `ProblemCode`, para que POST y
  vista previa coincidan. Alternativa o complemento: sumar las solicitudes contiguas del mismo
  tipo al aplicar el máximo por solicitud. Requiere migración (db-architect).
- Política de tipos por decidir: (a) impedir que el tipo `VAC` deje de descontar vacaciones (o
  pedir confirmación explícita), porque sin tope las vacaciones nuevas no las acotaría nada;
  (b) un tipo `PATERNIDAD` propio (Art. 132 fr. XXVII Bis: 5 días laborables con goce; confirmar
  la ley vigente) que no se pueda bajar del mínimo legal, separado del "Permiso con goce"
  discrecional; (c) jornadas que incluyen sábado (hoy los días hábiles son lunes a viernes).
- `updatedAt` (`@updatedAt` de Prisma) tiene precisión de milisegundos: dos guardados en el mismo
  milisegundo no se distinguirían en `STALE_DATA`. Si llega a importar, usar una columna
  `version` entera.
- Pantalla para consultar la bitácora de RH (filtros por entidad y por actor; ordenar por
  `createdAt` y luego `id`, porque varias filas de una transacción comparten `created_at`).
- `availableWithoutRequest` supone que la propia solicitud cae en el periodo calculado; dejaría
  de ser cierto si RH pudiera mover `hireDate` después de su `startDate`. Revisarlo en el CRUD
  de empleados.
- LFT pendiente de aplicar: Art. 78 (al menos 12 días continuos si el trabajador lo
  pide) y Art. 81 (las vacaciones se otorgan dentro de los 6 meses siguientes al
  aniversario).
- Prisma 7 lanza en paralelo las subconsultas de relaciones de una misma operación;
  dentro de una transacción interactiva eso dispara el aviso de `pg` "client.query()
  when the client is already executing a query", que en pg@9 será un error. Lo
  disparaba cargar el detalle completo (eventos, personas) dentro de la transacción;
  por eso dentro de transacciones se leen solo los campos necesarios y el detalle se
  carga después del commit. Revisar antes de actualizar `pg` a la v9.