class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.error = 'Validation error';
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
    this.error = 'Not found';
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.error = 'Conflict';
  }
}

class GoneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoneError';
    this.status = 410;
    this.error = 'Gone';
  }
}

module.exports = { ValidationError, NotFoundError, ConflictError, GoneError };
