const referenceOnly = document.documentElement.dataset.mode === 'reference';
const specUrl = new URL(document.documentElement.dataset.spec, location.href);
SwaggerUIBundle({
  dom_id: '#swagger-ui',
  url: specUrl.href,
  layout: 'BaseLayout',
  deepLinking: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: -1,
  persistAuthorization: false,
  queryConfigEnabled: false,
  validatorUrl: null,
  supportedSubmitMethods: referenceOnly ? [] : ['get', 'post', 'patch'],
  requestInterceptor(request) {
    const url = new URL(request.url, location.href);
    const readingSpec = url.href === specUrl.href && (request.method || 'GET').toUpperCase() === 'GET';
    if (
      url.origin !== location.origin ||
      (!readingSpec && (referenceOnly || !url.pathname.startsWith('/api/v1/')))
    ) {
      throw new Error('Requests are limited to this workspace.');
    }
    request.credentials = 'omit';
    request.redirect = 'error';
    return request;
  },
});
