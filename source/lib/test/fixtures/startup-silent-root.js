/**
 * A root module that forgot to register its element, which is the blank-page failure
 * `startApplication` turns into a message. It exports something so the import is not
 * optimised away by a reader.
 */

export const rootTag = 'startup-undefined-root';
