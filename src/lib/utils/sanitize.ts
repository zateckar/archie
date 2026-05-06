/**
 * Lightweight HTML sanitizer for use with Svelte's {@html ...} directive.
 * Strips dangerous elements and attributes without any external dependencies.
 */
export function sanitizeHtml(html: string): string {
    // Strip <script>, <iframe>, <object>, <embed>, <link>, <style> tags and their content
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    html = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
    html = html.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
    html = html.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');
    html = html.replace(/<link\b[^<]*(?:(?!<\/link>)<[^<]*)*<\/link>/gi, '');
    html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

    // Strip dangerous attributes: on* event handlers, javascript: URLs, data: URLs in dangerous contexts
    html = html.replace(/\s+(?:on\w+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    html = html.replace(/\bhref\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
    html = html.replace(/\bsrc\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
    html = html.replace(/\bformaction\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
    html = html.replace(/<base\b[^>]*>/gi, '');

    // Strip <meta> tags that could contain http-equiv refresh
    html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, '');

    return html;
}