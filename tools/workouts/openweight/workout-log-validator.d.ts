type ValidationError = { instancePath: string; message?: string };

declare const validate: ((data: unknown) => boolean) & { errors?: ValidationError[] | null };

export default validate;
