export class AppError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Solicitud inválida") {
    super(400, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "No autenticado") {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "No autorizado") {
    super(403, message);
  }
}
