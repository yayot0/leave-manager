export class AppError extends Error {
  readonly statusCode: number;
  /**
   * Optional machine-readable reason (e.g. "OVERLAP"), sent as `code` in the
   * error body so clients can react without parsing the message.
   */
  code?: string;

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

export class NotFoundError extends AppError {
  constructor(message = "No encontrado") {
    super(404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicto con el estado actual") {
    super(409, message);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message = "No se puede procesar la solicitud") {
    super(422, message);
  }
}

/**
 * Builds a module's `withCode(error, code)` helper: one implementation, and
 * each module only accepts its own codes (e.g. `createWithCode<HrErrorCode>()`).
 */
export function createWithCode<Code extends string>() {
  return function withCode<T extends AppError>(error: T, code: Code): T {
    error.code = code;
    return error;
  };
}
