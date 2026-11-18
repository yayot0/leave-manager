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
     o inactivo, 0 días hábiles. El POST la corre antes de la transacción.
  2. `evaluateAgainstUserState`: encimadas y saldo del periodo del `startDate`. El POST la
     corre dentro de la transacción, después de `lockUser`.
- Cada problema tiene un `code` (`START_IN_PAST`, `START_TOO_FAR`, `INVALID_LEAVE_TYPE`,
  `NO_BUSINESS_DAYS` → 400; `OVERLAP` → 409; `INSUFFICIENT_BALANCE` → 422). El POST lanza el
  primero y su error trae `{ error, code }`; el preview responde 200 con todos en
  `problems` y `canSubmit`. Los datos mal formados son 400 de Zod en ambos (el query del
  preview es `.strict()`: solo esos tres parámetros).
- El preview no escribe ni bloquea: es una foto; el POST revalida todo bajo el lock. Con un
  problema de fecha no calcula saldo (`balance: null`, sería de otro periodo) pero sí revisa
  encimadas; con tipo inválido se salta la fase 2. En ambos casos el POST ya habría fallado
  en la fase 1, así que `canSubmit` sigue coincidiendo.
- Toda regla nueva para crear solicitudes va en ese módulo, nunca solo en el POST.
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
- Títulos de sección: `CardTitle` es un `div`; envolver el texto en `<h2>`.
- Textos de la interfaz en español; código en inglés.
- `src/components/ui/` es código generado por shadcn: se puede editar, pero con
  cuidado y solo para adaptarlo (p. ej. traducir textos).
- Tests: con MSW (`src/test/server.ts`), nunca reemplazando `fetch` a mano;
  `renderApp(ruta)` (`src/test/render.tsx`) monta la app completa con las rutas reales.
  Consultar por rol y nombre accesible (`getByRole`, `getByLabelText`).
  `src/test/server.ts` trae respuestas por defecto (saldo, `mine` y `pending-approvals`
  vacías, tipos, preview). Para el detalle usar `mockDetail(...)`: un `http.get(".../:id")`
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
  cualquier migración que exista en la carpeta, revisada o no.

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
- Guardar en `leave_requests` si la solicitud descontaba saldo al crearla (copia de
  `countsAgainstVacationBalance`), o impedir editar ese campo en tipos que ya tienen
  solicitudes; hoy el saldo lo lee del tipo en el momento del cálculo, así que
  cambiarlo altera saldos hacia atrás. Decidirlo antes del CRUD de tipos para HR.
  Relacionado: la fase 1 de la creación lee el tipo y los festivos fuera del lock, así que un
  cambio de RH en ese instante no se ve (ventana de milisegundos).
- Límite de días por solicitud en tipos que no descuentan saldo: hoy no tienen tope (p. ej.
  se pudo pedir un "Día personal" de 22 días hábiles), porque el saldo es lo único que acota
  una solicitud. Como parte del CRUD de tipos de permiso (fase de RH), agregar un máximo de
  días hábiles por solicitud configurable por tipo (p. ej. `maxBusinessDaysPerRequest`,
  opcional = sin límite) y validarlo en `new-request-validation.ts` con un `ProblemCode` propio
  (p. ej. `EXCEEDS_TYPE_LIMIT`), para que el POST y la vista previa lo apliquen igual. La
  migración se revisa con db-architect antes de correr tests.
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