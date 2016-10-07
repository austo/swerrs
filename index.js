'use strict';

const EventEmitter = require('events'),
  pargs = require('./pargs');

function SwError() {
  let args = pargs.slice.apply(null, arguments);
  if (!(this instanceof SwError)) {
    let obj = Object.create(SwError.prototype);
    return newError(obj, args);
  }
  return newError(this, args);
}

function newError(swerr, argsArray) {

  const spec = swerr.constructor.spec,
    events = swerr.constructor.events;

  Object.keys(spec).forEach(k => {
    let v = renderTemplate(spec[k], spec);
    swerr[k] = v;
  });

  let args = pargs.parse(argsArray);

  swerr.message = args.message || swerr.message;
  swerr.values = args.values;

  Error.captureStackTrace(swerr, swerr.constructor);

  let ee = new EventEmitter();

  Object.keys(events).forEach(evt => {
    events[evt].forEach(fn => {
      ee.on(evt, fn.bind(swerr));
    });
  });

  Object.defineProperty(swerr, 'push', { value: makePush(swerr, ee) });
  Object.defineProperty(swerr, 'on', { value: makeOn(swerr, ee) });

  if (!swerr.asyncConstruct) {
    ee.listeners('constructed').forEach(fn => fn(swerr));
  }

  process.nextTick(() => {
    if (swerr.asyncConstruct) {
      ee.emit('constructed', swerr);
    }
    swerr.values.forEach(v => ee.emit('push', v));
  });

  return swerr;
}

function makePush(swerr, ee) {
  return function push(v) {
    swerr.values = swerr.values || [];
    swerr.values.push(v);
    ee.emit('push', v);
  };
}

function makeOn(swerr, ee) {
  return function on(evt, fn) {
    if (evt === 'constructed' || allowedEvents.indexOf(evt) === -1) {
      throw new TypeError(`SwError: unsupported event ${evt}`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError('second argument must be a function');
    }
    ee.on(evt, fn.bind(swerr));
    return swerr;
  };
}

SwError.prototype = Object.create(Error.prototype);
SwError.prototype.constructor = SwError;

SwError.prototype.transport = function() {
  return transport(this, !!this.serializeStack);
};

SwError.prototype.toJSON = function() {
  return this.transport();
};

SwError.prototype.hasValues = function() {
  return this.values.length > 0;
};

// NOTE: adding properties on the constructor itself
// is really not safe for V8 optimization
// (https://github.com/petkaantonov/bluebird/wiki/Optimization-killers#3-managing-arguments).
// We skirt the issue here by _always_ adding the same 4 properties to each
// extended constructor.

// TODO: It's optimizing correctly now, but...
// Maybe objects get non-enumerable prototype guids,
// then consult a private map of spec/events??

SwError.spec = Object.freeze({
  name: 'SwError',
  message: '{{name}} aggregated error',
  serializeStack: false
});

SwError.events = {};
SwError.parent = Error;

// TODO: can we put the spec items on the extension's prototype?
SwError.extend = makeExtend(SwError);

module.exports = SwError;

// TODO: JSDoc!

// Below here is private

function makeExtend(parent) {
  return function(props) {
    const extensionProps = mergeSpecs(parent, props);
    const child = extend(parent);
    child.spec = extensionProps.spec;
    child.events = extensionProps.events;
    child.parent = parent;
    child.extend = makeExtend(child);
    return child;
  };
}

function extend(clazz) {
  if (nAncestors(clazz) >= 10) { // TODO: make configurable??
    throw new TypeError('SwError: inheritance limit reached');
  }

  function SwErrorExtension() {
    let args = pargs.slice.apply(null, arguments);
    if (!(this instanceof SwErrorExtension)) {
      let obj = Object.create(SwErrorExtension.prototype);
      return newError(obj, args);
    }
    return newError(this, args);
  }
  SwErrorExtension.prototype = Object.create(clazz.prototype);
  SwErrorExtension.prototype.constructor = SwErrorExtension;
  return SwErrorExtension;
}

const allowedEvents = ['constructed', 'push'];
const allowedEventsRe = new RegExp('^on(' +
  allowedEvents
  .map(e => e[0].toUpperCase() + e.substr(1))
  .join('|') + ')$');

function mergeSpecs(parent, childProps) {
  let result = {
    spec: {},
    events: {}
  };
  Object.keys(parent.spec).forEach(k => {
    result.spec[k] = parent.spec[k];
  });
  Object.keys(parent.events).forEach(k => {
    result.events[k] = parent.events[k].slice();
  });
  Object.keys(childProps).forEach(k => {
    if (!allowedEventsRe.test(k)) {
      result.spec[k] = childProps[k];
      return;
    }
    let evt = k.replace(allowedEventsRe, (match, evt) => evt.toLowerCase());
    if (typeof childProps[k] === 'function') {
      result.events[evt] = result.events[evt] || [];
      result.events[evt].push(childProps[k]);
      return;
    }
    if (childProps[k] === null) {
      result.events[evt] = [];
    }
  });
  return result;
}

function nAncestors(clazz) {
  var i = 0;
  let parent = clazz.parent;

  while (parent && parent.spec) {
    i++;
    parent = parent.parent;
  }
  return i;
}

function copySafe(dst, src, serializeStack) {
  Object.getOwnPropertyNames(src).forEach(k => {
    if (!serializeStack && k === 'stack') {
      return;
    }
    if (typeof src[k] === 'function') {
      return;
    }
    dst[k] = transport(src[k], serializeStack);
  });
  return dst;
}

function transport(v, serializeStack) {
  let t = type(v);

  switch (t) {
    case 'Object':
      return copySafe({}, v, serializeStack);
    case 'Error':
      return copySafe({
        name: v.constructor.name
      }, v, serializeStack);
    case 'Array':
      return v.map(x => transport(x, serializeStack));
    default:
      return v;
  }
}

const templateParamRe = /{{(\w+)}}/g;

function renderTemplate(tmpl, params) {
  if (typeof tmpl !== 'string') {
    return tmpl;
  }
  return tmpl.replace(templateParamRe, (match, param) => {
    if (typeof params[param] !== 'string') {
      return '';
    }
    return params[param];
  });
}

const typeRe = /^\[object\s(\w+)\]$/;

function type(v) {
  let m = typeRe.exec(Object.prototype.toString.call(v));

  if (!m) {
    throw new RangeError('wtf');
  }

  return m[1];
}
