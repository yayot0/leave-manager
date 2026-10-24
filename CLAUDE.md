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

## Pendientes técnicos
- Configurar CORS (`cors()` con `credentials: true` y origin explícito) cuando el
  cliente (`client/`, Vite) empiece a consumir la API con cookies desde otro origen.
- Configurar `app.set("trust proxy", ...)` antes de desplegar detrás de un proxy o
  load balancer, para que `express-rate-limit` identifique la IP real del cliente.
- Migrar `DATABASE_URL` (hoy leído directo de `process.env` en `server/src/db/prisma.ts`)
  al schema de Zod de `server/src/config/env.ts`, por consistencia con el resto de las
  variables de entorno.