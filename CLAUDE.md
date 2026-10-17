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