import { configValidationSchema } from './app.config';

/** Preserve Joi validation semantics through Nest Config's custom validator API. */
export function validateEnvironment(environment: Record<string, unknown>): Record<string, unknown> {
  const { error, value } = configValidationSchema.validate(environment, {
    abortEarly: false,
    allowUnknown: true,
  });
  if (error) throw new Error('Config validation error: ' + error.message);
  return value;
}
