// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { Observable } from 'rxjs/Observable';
import * as uuid from 'uuid/v4';
import { CancellationToken } from 'vscode-jsonrpc';
import * as vsls from 'vsls/vscode';
import * as vscode from 'vscode';

import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../../common/types';
import { LiveShare, LiveShareCommands } from '../../constants';
import { ICell, IJupyterSessionManager, InterruptResult, IDataScience } from '../../types';
import { JupyterServerBase } from '../jupyterServerBase';
import { ServerResponse, ServerResponseType, IResponseMapping } from './types';
import { ICatchupRequest } from './types';
import { waitForHostService } from './utils';

export class HostJupyterServer extends JupyterServerBase {
    private service: Promise<vsls.SharedService | undefined>;
    private responseBacklog : { responseTime: number, response: ServerResponse }[] = [];

    constructor(
        dataScience: IDataScience,
        logger: ILogger,
        disposableRegistry: IDisposableRegistry,
        asyncRegistry: IAsyncDisposableRegistry,
        configService: IConfigurationService,
        sessionManager: IJupyterSessionManager) {
        super(dataScience, logger, disposableRegistry, asyncRegistry, configService, sessionManager);
        this.service = this.startSharedService();
    }

    public async dispose(): Promise<void> {
        await super.dispose();
        const api = await vsls.getApiAsync();
        api.unshareService(LiveShare.JupyterServerSharedService);
    }

    public executeObservable(code: string, file: string, line: number, id?: string): Observable<ICell[]> {
        try {
            const inner = super.executeObservable(code, file, line, id);

            // Wrap the observable returned so we can listen to it too
            return this.wrapObservableResult(code, inner, id);

        } catch (exc) {
            this.postException(exc);
            throw exc;
        }

    }

    public async restartKernel(): Promise<void> {
        try {
            const time = Date.now();
            await super.restartKernel();
            this.postResult(ServerResponseType.Restart, {type: ServerResponseType.Restart, time});
        } catch (exc) {
            this.postException(exc);
            throw exc;
        }
    }

    public async interruptKernel(timeoutMs: number): Promise<InterruptResult> {
        try {
            const time = Date.now();
            const result = await super.interruptKernel(timeoutMs);
            this.postResult(ServerResponseType.Interrupt, {type: ServerResponseType.Interrupt, time, result});
            return result;
        } catch (exc) {
            this.postException(exc);
            throw exc;
        }
    }

    private translateCellForGuest(api: vsls.LiveShare, cell: ICell) : ICell {
        const copy = {...cell};
        copy.file = api.convertLocalUriToShared(vscode.Uri.file(copy.file)).fsPath;
        return copy;
    }

    private async startSharedService() : Promise<vsls.SharedService | undefined> {
        const api = await vsls.getApiAsync();

        if (api) {
            const service = await waitForHostService(api, LiveShare.JupyterServerSharedService);

            // Attach event handlers to different requests
            service.onRequest(LiveShareCommands.syncRequest, (args: object, cancellation: CancellationToken) => this.onSync());
            service.onRequest(LiveShareCommands.getSysInfo, (args: any[], cancellation: CancellationToken) => this.onGetSysInfoRequest(service, cancellation))
            service.onNotify(LiveShareCommands.catchupRequest, (args: object) => this.onCatchupRequest(service, args));

            return service;
        }
    }

    private onSync() : Promise<any> {
        return Promise.resolve(true);
    }

    private onGetSysInfoRequest(service: vsls.SharedService, cancellation: CancellationToken) : Promise<any> {
        // Get the sys info from our local server
        return super.getSysInfo();
    }

    private onCatchupRequest(service: vsls.SharedService, args: object) {
        if (args.hasOwnProperty('since')) {
            const request = args as ICatchupRequest;

            // Send results for all of the responses that are after the start time
            this.responseBacklog.forEach(r => {
                if (r.responseTime >= request.since) {
                    service.notify(LiveShareCommands.serverResponse, r.response);

                    // Keep them in the response backlog as another guest may need them too
                }
            });
        }
    }

    private wrapObservableResult(code: string, observable: Observable<ICell[]>, id?: string) : Observable<ICell[]> {
        return new Observable(subscriber => {
            // We need the api to translate cells
            vsls.getApi().then((api) => {
                // Generate a new id or use the one passed in to identify everything that happened
                const newId = id ? id : uuid();
                let pos = 0;

                // Listen to all of the events on the observable passed in.
                observable.subscribe(cells => {
                    // Forward to the next listener
                    subscriber.next(cells);

                    // Send across to the guest side
                    const translated = cells.map(c => this.translateCellForGuest(api, c));
                    this.postObservableNext(code, pos, translated, newId);
                    pos += 1;
                },
                e => {
                    subscriber.error(e);
                    this.postException(e);
                },
                () => {
                    subscriber.complete();
                    this.postObservableComplete(code, pos, newId);
                });

            }).ignoreErrors();
        })
    }

    private postObservableNext(code: string, pos: number, cells: ICell[], id: string) {
        this.postResult(ServerResponseType.ExecuteObservable, { code, pos, type: ServerResponseType.ExecuteObservable, cells, id, time: Date.now() });
    }

    private postObservableComplete(code: string, pos: number, id: string) {
        this.postResult(ServerResponseType.ExecuteObservable, { code, pos, type: ServerResponseType.ExecuteObservable, cells: undefined, id, time: Date.now() });
    }

    private postException(exc: any) {
        this.postResult(ServerResponseType.Exception, {type: ServerResponseType.Exception, time: Date.now(), message: exc.toString()});
    }

    private async postResult<R extends IResponseMapping, T extends keyof R>(type: T, result: R[T]) : Promise<void> {
        const service = await this.service;
        const typedResult = ((result as any) as ServerResponse);
        service.notify(LiveShareCommands.serverResponse, typedResult);

        // Need to also save in memory for those guests that are in the middle of starting up
        this.responseBacklog.push({ responseTime: Date.now(), response: typedResult });
    }
}
