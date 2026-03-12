function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  const statusCode = err.status || 500;
  const error = err.error || 'Internal server error';

  // Don't leak stack traces in production
  const message = process.env.NODE_ENV === 'development'
    ? err.message
    : (statusCode === 500 ? 'An unexpected error occurred' : err.message);

  res.status(statusCode).json({
    success: false,
    error,
    message,
  });
}

module.exports = errorHandler;
