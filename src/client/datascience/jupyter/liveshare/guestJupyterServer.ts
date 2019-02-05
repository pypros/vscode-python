// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { Observable } from 'rxjs/Observable';
import { Subscriber } from 'rxjs/Subscriber';
import { CancellationToken } from 'vscode-jsonrpc';
import * as vsls from 'vsls/vscode';

import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../../common/types';
import { createDeferred, Deferred } from '../../../common/utils/async';
import { LiveShare, LiveShareJupyterCommands } from '../../constants';
import {
    ICell,
    IConnection,
    IJupyterKernelSpec,
    IJupyterSessionManager,
    INotebookServer,
    InterruptResult
} from '../../types';
import {
    ExecuteObservableResponse,
    ExecuteResponse,
    InterruptResponse,
    ServerResponse,
    ServerResponseType
} from './serverResponse';

export class GuestJupyterServer implements INotebookServer {
    private connInfo : IConnection | undefined;
    private responseQueue : ServerResponse [] = [];
    private waitingQueue : { deferred: Deferred<ServerResponse>; predicate : (r: ServerResponse) => boolean }[] = [];

    constructor(
        private logger: ILogger,
        private disposableRegistry: IDisposableRegistry,
        private asyncRegistry: IAsyncDisposableRegistry,
        private configService: IConfigurationService,
        private sessionManager: IJupyterSessionManager) {
        this.startSharedServiceProxy().ignoreErrors();
    }

    public async connect(connInfo: IConnection, kernelSpec: IJupyterKernelSpec | undefined, usingDarkTheme: boolean, cancelToken?: CancellationToken, workingDir?: string): Promise<void> {
        this.connInfo = connInfo;
        return Promise.resolve();
    }

    public shutdown(): Promise<void> {
        return Promise.resolve();
    }

    public dispose(): Promise<void> {
        return Promise.resolve();
    }

    public waitForIdle(): Promise<void> {
        return Promise.resolve();
    }

    public async execute(code: string, file: string, line: number, cancelToken?: CancellationToken): Promise<ICell[]> {
        // Wait for the response from the server
        const response = await this.waitForExecuteResponse<ExecuteResponse>(code, file, line);
        return response.cells;
    }

    public setInitialDirectory(directory: string): Promise<void> {
        // Ignore this command on this side
        return Promise.resolve();
    }

    public executeObservable(code: string, file: string, line: number, id?: string): Observable<ICell[]> {
        // Create a wrapper observable around the actual server
        return new Observable<ICell[]>(subscriber => {
            // Wait for our first response
            this.waitForExecuteResponse<ExecuteObservableResponse>(code, file, line, id)
                .then(r => {
                    // This is our first response to the subscriber, but then keep listening
                    subscriber.next(r.cells);

                    this.waitForObservable(subscriber, r.id).catch(e => subscriber.error(e));
                })
                .catch(e => {
                    subscriber.error(e);
                    subscriber.complete();
                });
        });
    }

    public async executeSilently(code: string, cancelToken?: CancellationToken): Promise<void> {
        await this.waitForSpecificResponse(r => {
            if (r.type === ServerResponseType.Execute) {
                const er = r as ExecuteResponse;
                return (er.cells.length > 0 && er.cells[0].data.source === code);
            }
        });
    }

    public async restartKernel(): Promise<void> {
        await this.waitForResponse(ServerResponseType.Restart);
    }

    public async interruptKernel(timeoutMs: number): Promise<InterruptResult> {
        const response = await this.waitForResponse(ServerResponseType.Restart);
        return (response as InterruptResponse).result;
    }

    // Return a copy of the connection information that this server used to connect with
    public getConnectionInfo(): IConnection | undefined {
        return this.connInfo;
    }

    private async startSharedServiceProxy() : Promise<void> {
        const api = await vsls.getApiAsync();

        if (api) {
            const service = await api.getSharedService(LiveShare.JupyterServerSharedService);
            service.onNotify(LiveShareJupyterCommands.serverResponse, this.onServerResponse);
        }
    }

    private onServerResponse = (args: Object) => {
        // Args should be of type ServerResponse. Stick in our queue if so.
        if (args.hasOwnProperty('type')) {
            this.responseQueue.push(args as ServerResponse);

            // Check for any waiters.
            this.dispatchResponses();
        }
    }

    private async waitForObservable(subscriber: Subscriber<ICell[]>, id: string) : Promise<void> {
        let cells : ICell[] = [];
        while (cells !== undefined) {
            const response = await this.waitForSpecificResponse<ExecuteObservableResponse>(r => {
                if (r.type === ServerResponseType.ExecuteObservable) {
                    return (r as ExecuteObservableResponse).id === id;
                }
            });
            cells = response.cells;
            if (cells !== undefined) {
                subscriber.next(cells);
            }
        }
        subscriber.complete();
    }

    private async waitForExecuteResponse<T extends ServerResponse>(code: string, file: string, line: number, id?: string) : Promise<T> {
        const response = await this.waitForSpecificResponse(r => {
            if (r.type === ServerResponseType.Execute) {
                const er = r as ExecuteResponse;
                return (er.cells.length > 0 &&
                    er.cells[0].file === file &&
                    er.cells[0].line === line &&
                    er.cells[0].data.source === code &&
                    (!id || id === er.cells[0].id));
            }
        });
        return response as T;
    }

    private waitForSpecificResponse<T extends ServerResponse>(predicate: (response: ServerResponse) => boolean) : Promise<T> {
        // See if we have any responses right now with this type
        const index = this.responseQueue.findIndex(predicate);
        if (index >= 0) {
            // Pull off the match
            const match = this.responseQueue[index];

            // Remove from the response queue
            this.responseQueue = this.responseQueue.splice(index);

            // Return this single item
            return Promise.resolve(match as T);
        } else {
            // We have to wait for a new input to happen
            const waitable = { deferred: createDeferred<T>(), predicate };
            this.waitingQueue.push(waitable);
            return waitable.deferred.promise;
        }
    }

    private waitForResponse(type: ServerResponseType) : Promise<ServerResponse> {
        return this.waitForSpecificResponse(r => r.type === type);
    }

    private dispatchResponses() {
        // Look through all of our responses that are queued up and see if they make a
        // waiting promise resolve
        for (let i = 0; i < this.responseQueue.length; i += 1) {
            const response = this.responseQueue[i];
            const matchIndex = this.waitingQueue.findIndex(w => w.predicate(response));
            if (matchIndex >= 0) {
                this.waitingQueue[matchIndex].deferred.resolve(response);
                this.waitingQueue = this.waitingQueue.splice(matchIndex);
                this.responseQueue = this.responseQueue.splice(i);
                i -= 1; // Offset the addition as we removed this item
            }
        }
    }
}
