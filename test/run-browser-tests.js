/*
 * Runs the QUnit suite (test/index.html) in headless Chrome and reports
 * per-test results plus a summary. Exit code 0 only if every test passed.
 *
 * Usage: CHROME_BIN=/usr/bin/google-chrome-stable \
 *          node test/run-browser-tests.js http://127.0.0.1:8000/test/index.html
 * Requires node >= 18, puppeteer-core resolvable (e.g. via NODE_PATH), and
 * CHROME_BIN set to the Chrome/Chromium executable to drive.
 */
"use strict";

var puppeteer = require( "puppeteer-core" );

var url = process.argv[ 2 ];
var TIMEOUT_MS = 20 * 60 * 1000;
var MAX_PAGE_LINES = 50;
var PHP_LOG = "/tmp/php-server.log";

var tests = { total: 0, passed: 0, failed: 0 };
var failedAssertions = [];
var currentModule = "";
var lastTest = "(none)";
var pageLines = 0;
var browser;
var finished = false;

if ( !url ) {
	console.error( "Usage: node run-browser-tests.js <url>" );
	process.exit( 2 );
}

if ( !process.env.CHROME_BIN ) {
	console.error( "CHROME_BIN is not set; point it at the Chrome executable to drive" );
	process.exit( 2 );
}

function finish( code ) {
	if ( finished ) {
		return;
	}
	finished = true;
	if ( code !== 0 ) {
		console.log( "Hint: PHP server log is at " + PHP_LOG );
	}
	var close = browser ? browser.close().catch( function() {} ) : Promise.resolve();
	close.then( function() {
		process.exit( code );
	} );
}

function pageLine( text ) {
	pageLines++;
	if ( pageLines <= MAX_PAGE_LINES ) {
		console.log( "[page] " + String( text ).slice( 0, 300 ) );
	} else if ( pageLines === MAX_PAGE_LINES + 1 ) {
		console.log( "[page] (further page errors suppressed)" );
	}
}

// Runs in the page before any of its scripts. Installs a setter trap on
// window.QUnit so the logging callbacks are registered the moment qunit.js
// assigns the global, well before loadTests() calls QUnit.start().
function installHooks() {
	// Iframes in the suite read parent.QUnit; leave their window alone.
	if ( window.top !== window ) {
		return;
	}
	var stored;
	var hooked = false;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return stored;
		},
		set: function( q ) {
			stored = q;
			if ( hooked || !q || typeof q.testDone !== "function" ) {
				return;
			}
			hooked = true;
			var str = function( v ) {
				try {
					return typeof v === "string" ? v : JSON.stringify( v );
				} catch ( e ) {
					return String( v );
				}
			};
			q.moduleStart( function( d ) {
				window.__qmoduleStart( d.name || "" );
			} );
			q.log( function( d ) {
				if ( !d.result ) {
					window.__qlog( {
						module: d.module || "",
						name: d.name || "",
						message: d.message ? String( d.message ) : "",
						actual: str( d.actual ),
						expected: str( d.expected ),
						source: d.source ? String( d.source ) : ""
					} );
				}
			} );
			q.testDone( function( d ) {
				window.__qtestDone( {
					module: d.module || "",
					name: d.name || "",
					failed: d.failed,
					passed: d.passed,
					total: d.total
				} );
			} );
			q.done( function( d ) {
				window.__qdone( {
					failed: d.failed,
					passed: d.passed,
					total: d.total,
					runtime: d.runtime
				} );
			} );
		}
	} );
}

async function main() {
	browser = await puppeteer.launch( {
		headless: true,
		executablePath: process.env.CHROME_BIN,
		args: [ "--no-sandbox", "--disable-setuid-sandbox" ]
	} );
	console.log( "Chrome version: " + ( await browser.version() ) );

	var page = await browser.newPage();

	page.on( "console", function( msg ) {
		if ( msg.type() === "error" ) {
			pageLine( "console.error: " + msg.text() );
		}
	} );
	page.on( "pageerror", function( err ) {
		pageLine( "pageerror: " + ( err && err.message ? err.message : err ) );
	} );

	await page.exposeFunction( "__qmoduleStart", function( name ) {
		currentModule = name;
	} );

	await page.exposeFunction( "__qlog", function( d ) {
		failedAssertions.push( d );
	} );

	await page.exposeFunction( "__qtestDone", function( d ) {
		var mod = d.module || currentModule;
		lastTest = mod + " :: " + d.name;
		tests.total++;
		if ( d.failed === 0 ) {
			tests.passed++;
			console.log( "PASS " + lastTest + " (" + d.passed + "/" + d.total + " assertions)" );
		} else {
			tests.failed++;
			console.log( "FAIL " + lastTest + " (" + d.failed + " failed, " +
				d.passed + "/" + d.total + ")" );
			failedAssertions.forEach( function( a ) {
				console.log( "    - " + ( a.message || "(no message)" ) );
				console.log( "      actual:   " + a.actual );
				console.log( "      expected: " + a.expected );
				if ( a.source ) {
					console.log( "      source:   " + a.source.split( "\n" ).join( "\n                " ) );
				}
			} );
		}
		failedAssertions = [];
	} );

	await page.exposeFunction( "__qdone", function( d ) {
		console.log( "" );
		console.log( "Tests: " + tests.total + " total, " + tests.passed + " passed, " +
			tests.failed + " failed" );
		console.log( "Assertions: " + d.total + " total, " + d.passed + " passed, " +
			d.failed + " failed, runtime " + d.runtime + "ms" );
		finish( tests.failed === 0 && tests.total > 0 ? 0 : 1 );
	} );

	await page.evaluateOnNewDocument( installHooks );

	console.log( "Opening " + url );
	await page.goto( url, { waitUntil: "load", timeout: 120000 } );
}

setTimeout( function() {
	console.log( "TIMEOUT after " + ( TIMEOUT_MS / 60000 ) + " minutes; last test seen: " + lastTest );
	console.log( "Tests so far: " + tests.total + " total, " + tests.passed + " passed, " +
		tests.failed + " failed" );
	finish( 1 );
}, TIMEOUT_MS );

main().catch( function( err ) {
	console.error( "Runner error: " + ( err && err.stack ? err.stack : err ) );
	finish( 1 );
} );
