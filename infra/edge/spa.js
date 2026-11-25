function handler(event) {
  var request = event.request;
  var path = request.uri;
  if (path === '/api' || path === '/media' || path === '/reveals') {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  if (path === '/' || (!path.startsWith('/assets/') && !path.split('/').pop().includes('.'))) {
    request.uri = '/index.html';
  }
  return request;
}
