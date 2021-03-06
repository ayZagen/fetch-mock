const { debug, setDebugPhase, getDebug } = require('./debug');
const responseBuilder = require('./response-builder');
const requestUtils = require('./request-utils');
const FetchMock = {};

// see https://heycam.github.io/webidl/#aborterror for the standardised interface
// Note that this differs slightly from node-fetch
class AbortError extends Error {
	constructor() {
		super(...arguments);
		this.name = 'AbortError';
		this.message = 'The operation was aborted.';

		// Do not include this class in the stacktrace
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

const resolve = async (
	{ response, responseIsFetch = false },
	url,
	options,
	request
) => {
	const debug = getDebug('resolve()');
	debug('Recursively resolving function and promise responses');
	// We want to allow things like
	// - function returning a Promise for a response
	// - delaying (using a timeout Promise) a function's execution to generate
	//   a response
	// Because of this we can't safely check for function before Promisey-ness,
	// or vice versa. So to keep it DRY, and flexible, we keep trying until we
	// have something that looks like neither Promise nor function
	while (true) {
		if (typeof response === 'function') {
			debug('  Response is a function');
			// in the case of falling back to the network we need to make sure we're using
			// the original Request instance, not our normalised url + options
			if (responseIsFetch) {
				if (request) {
					debug('  -> Calling fetch with Request instance');
					return response(request);
				}
				debug('  -> Calling fetch with url and options');
				return response(url, options);
			} else {
				debug('  -> Calling response function');
				response = response(url, options, request);
			}
		} else if (typeof response.then === 'function') {
			debug('  Response is a promise');
			debug('  -> Resolving promise');
			response = await response;
		} else {
			debug('  Response is not a function or a promise');
			debug('  -> Exiting response resolution recursion');
			return response;
		}
	}
};

FetchMock.fetchHandler = function (url, options, request) {
	setDebugPhase('handle');
	const debug = getDebug('fetchHandler()');
	debug('fetch called with:', url, options);
	const normalizedRequest = requestUtils.normalizeRequest(
		url,
		options,
		this.config.Request
	);

	({ url, options, request } = normalizedRequest);

	const { signal } = normalizedRequest;

	debug('Request normalised');
	debug('  url', url);
	debug('  options', options);
	debug('  request', request);
	debug('  signal', signal);

	if (request && this.routes.some(({ usesBody }) => usesBody)) {
		debug(
			'Need to wait for Body to be streamed before calling router: switching to async mode'
		);
		return this._asyncFetchHandler(url, options, request, signal);
	}
	return this._fetchHandler(url, options, request, signal);
};

FetchMock._asyncFetchHandler = async function (url, options, request, signal) {
	options.body = await options.body;
	return this._fetchHandler(url, options, request, signal);
};

FetchMock._fetchHandler = function (url, options, request, signal) {
	const route = this.executeRouter(url, options, request);

	// this is used to power the .flush() method
	let done;
	this._holdingPromises.push(new this.config.Promise((res) => (done = res)));

	// wrapped in this promise to make sure we respect custom Promise
	// constructors defined by the user
	return new this.config.Promise((res, rej) => {
		if (signal) {
			debug('signal exists - enabling fetch abort');
			const abort = () => {
				debug('aborting fetch');
				// note that DOMException is not available in node.js; even node-fetch uses a custom error class: https://github.com/bitinn/node-fetch/blob/master/src/abort-error.js
				rej(
					typeof DOMException !== 'undefined'
						? new DOMException('The operation was aborted.', 'AbortError')
						: new AbortError()
				);
				done();
			};
			if (signal.aborted) {
				debug('signal is already aborted - aborting the fetch');
				abort();
			}
			signal.addEventListener('abort', abort);
		}

		this.generateResponse(route, url, options, request)
			.then(res, rej)
			.then(done, done)
			.then(() => {
				setDebugPhase();
			});
	});
};

FetchMock.fetchHandler.isMock = true;

FetchMock.executeRouter = function (url, options, request) {
	const debug = getDebug('executeRouter()');
	debug(`Attempting to match request to a route`);
	if (this.getOption('fallbackToNetwork') === 'always') {
		debug(
			'  Configured with fallbackToNetwork=always - passing through to fetch'
		);
		return { response: this.getNativeFetch(), responseIsFetch: true };
	}

	const match = this.router(url, options, request);

	if (match) {
		debug('  Matching route found');
		return match;
	}

	if (this.getOption('warnOnFallback')) {
		console.warn(`Unmatched ${(options && options.method) || 'GET'} to ${url}`); // eslint-disable-line
	}

	this.push({ url, options, request, isUnmatched: true });

	if (this.fallbackResponse) {
		debug('  No matching route found - using fallbackResponse');
		return { response: this.fallbackResponse };
	}

	if (!this.getOption('fallbackToNetwork')) {
		throw new Error(
			`fetch-mock: No fallback response defined for ${
				(options && options.method) || 'GET'
			} to ${url}`
		);
	}

	debug('  Configured to fallbackToNetwork - passing through to fetch');
	return { response: this.getNativeFetch(), responseIsFetch: true };
};

FetchMock.generateResponse = async function (route, url, options, request) {
	const debug = getDebug('generateResponse()');
	const response = await resolve(route, url, options, request);

	// If the response says to throw an error, throw it
	// Type checking is to deal with sinon spies having a throws property :-0
	if (response.throws && typeof response !== 'function') {
		debug('response.throws is defined - throwing an error');
		throw response.throws;
	}

	// If the response is a pre-made Response, respond with it
	if (this.config.Response.prototype.isPrototypeOf(response)) {
		debug('response is already a Response instance - returning it');
		return response;
	}

	// finally, if we need to convert config into a response, we do it
	return responseBuilder({
		url,
		responseConfig: response,
		fetchMock: this,
		route,
	});
};

FetchMock.router = function (url, options, request) {
	const route = this.routes.find((route, i) => {
		debug(`Trying to match route ${i}`);
		return route.matcher(url, options, request);
	});

	if (route) {
		this.push({
			url,
			options,
			request,
			identifier: route.identifier,
		});
		return route;
	}
};

FetchMock.getNativeFetch = function () {
	const func = this.realFetch || (this.isSandbox && this.config.fetch);
	if (!func) {
		throw new Error(
			'fetch-mock: Falling back to network only available on global fetch-mock, or by setting config.fetch on sandboxed fetch-mock'
		);
	}
	return func;
};

FetchMock.push = function ({ url, options, request, isUnmatched, identifier }) {
	debug('Recording fetch call', {
		url,
		options,
		request,
		isUnmatched,
		identifier,
	});
	const args = [url, options];
	args.request = request;
	args.identifier = identifier;
	args.isUnmatched = isUnmatched;
	this._calls.push(args);
};

module.exports = FetchMock;
