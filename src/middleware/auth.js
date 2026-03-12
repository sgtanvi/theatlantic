/**
 * Development authentication middleware
 *
 * Reads x-user-id from the request header and looks up the user in the
 * database. Sets req.user for downstream handlers.
 *
 * See docs/api/authentication.md for the production strategy (session cookies
 * or Bearer JWT). This middleware is intentionally simple for the dev/test
 * environment.
 */

const { pool } = require('../config/database');

/**
 * Authenticate the request via the x-user-id header.
 * Returns 401 if the header is absent or the user does not exist.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticateUser(req, res, next) {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'x-user-id header required',
    });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not found',
      });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authenticateUser };
