/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
// cSpell:words ansible
'use strict';

import {
	Files, IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument,
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem,
	CompletionItemKind
} from 'vscode-languageserver';

import { exec, spawn } from "child_process";

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities. 
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
	workspaceRoot = params.rootPath;
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind
		}
	}
});

// The content of a ansible document has saved. This event is emitted
// when the document get saved 
documents.onDidSave((event) => {
	validateAnsibleFile(event.document);
});

documents.onDidOpen((event) => {
	validateAnsibleFile(event.document);
});

documents.onDidClose((event) => {
	let diagnostics: Diagnostic[] = [];
	connection.sendDiagnostics({ uri: event.document.uri.toString(), diagnostics });
});
// The settings interface describe the server relevant settings part
interface Settings {
	ansibleLinter: ansibleLinterSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface ansibleLinterSettings {
	maxNumberOfProblems: number;
}

// hold the maxNumberOfProblems setting
let maxNumberOfProblems: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
	let settings = <Settings>change.settings;
	maxNumberOfProblems = settings.ansibleLinter.maxNumberOfProblems || 100;
	// Revalidate any open text documents
	documents.all().forEach(validateAnsibleFile);
});

let isValidating: { [index: string]: boolean } = {};

function validateAnsibleFile(document: TextDocument): void {
	let uri = document.uri;

	if (isValidating[uri]) {
		return;
	};

	isValidating[uri] = true;

	let cmd = "ansible-lint"

	let file_to_lint = Files.uriToFilePath(uri)
	if (file_to_lint.search(/\/tasks\//i) !== -1) {
		file_to_lint = file_to_lint.substr(0, (file_to_lint.search(/\/tasks\//i)))
	}

	// cSpell:ignore nocolor
	let args = ["-p", "--nocolor", file_to_lint];

	connection.console.log(`running............. ${cmd} ${args}`);

	let child = spawn(cmd, args);

	let diagnostics: Diagnostic[] = [];
	let filename = uri.toString()
	let start = 0;
	let end = Number.MAX_VALUE;

	child.stderr.on("data", (data: Buffer) => {
		let err = data.toString();
		connection.console.log(err);
		let lineNumber = 0
		let diagnostic: Diagnostic = {
			range: {
				start: { line: lineNumber, character: start },
				end: { line: lineNumber, character: end }
			},
			severity: DiagnosticSeverity.Warning,
			message: err
		};
		diagnostics.push(diagnostic);
	});

	child.stdout.on("data", (data: Buffer) => {
		let tmp = data.toString();
		const lint_regex = /(.*):(\d+).*[ANSIBL]*E\d{3,4}\]\s(.*)/;
		tmp.split(/\r?\n/).forEach(function (line) {

			const lint_matches = lint_regex.exec(line);

			if (lint_matches) {
				if (filename != 'file://' + lint_matches[1]) {
					connection.sendDiagnostics({ uri: filename, diagnostics });
					diagnostics = new Array<Diagnostic>();
					filename = 'file://' + lint_matches[1];
				}

				let lineNumber = (Number.parseInt(lint_matches[2]) - 1)
				let diagnostic: Diagnostic = {
					range: {
						start: { line: lineNumber, character: start },
						end: { line: lineNumber, character: end }
					},
					severity: DiagnosticSeverity.Warning,
					message: lint_matches[3]
				};
				diagnostics.push(diagnostic);
			}
		});
	});

	child.on("close", () => {
		//connection.console.log(`Validation finished for(code:${code}): ${Files.uriToFilePath(uri)}`);
		connection.sendDiagnostics({ uri: filename, diagnostics });
		isValidating[uri] = false;
	});
}

// Listen on the connection
connection.listen();
