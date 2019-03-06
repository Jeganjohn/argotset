import * as express from 'express';
import * as bodyParser from 'body-parser';
import * as expressWinston from 'express-winston';

import * as common from './common';
import * as util from './util';
import { CiProcessor } from './ci-processor';
import { ConfigManager } from './config-manager';

function wrap(action: (req: express.Request) => Promise<any>) {
    return (req: express.Request, res: express.Response) => {
        action(req)
            .then(data => {
                res.send(data);
            })
            .catch(e => {
                res.statusCode = e.statusCode || 500;
                res.send({
                    message: e.message || e,
                });
                if (res.statusCode === 500) {
                    util.logger.error('Failed to process request %s', req.url, e);
                }
            });
    };
}

export async function createServers(
    options: {
        repoDir: string,
        inCluster: boolean,
        namespace: string,
        workflowsNamespace: string,
        version: string,
        argoCiImage: string,
        configPrefix: string,
        controllerInstanceId: string,
    }) {
    const expressLogger = expressWinston.logger({
        transports: [util.winstonTransport],
        meta: false,
        msg: '{{res.statusCode}} {{req.method}} {{res.responseTime}}ms {{req.url}}',
    });

    const crdKubeClient = util.createKubeCrdClient(options.inCluster, options.workflowsNamespace, 'argoproj.io', options.version);
    const coreKubeClient = util.createKubeCoreClient(options.inCluster, options.namespace);
    const configManager = await ConfigManager.create(options.configPrefix, coreKubeClient);
    const processor = new CiProcessor(
        options.repoDir, crdKubeClient, options.argoCiImage, options.namespace, options.workflowsNamespace, options.controllerInstanceId, configManager);

    const webHookServer = express();
    webHookServer.use(expressLogger);

    webHookServer.post('/api/webhook/:type', wrap(async req => {
        const scmByType = await configManager.getScms();
        const scm = scmByType.get(req.params.type);
        if (scm) {
            const event = await scm.parseEvent(req);
            if (event) {
                processor.processGitEvent(scm, event);
            }
            return {ok: true };
        } else {
            throw { statusCode: 404, message: `Webhook for '${req.params.type}' is not supported` };
        }
    }));

    const apiServer = express();
    apiServer.use(expressLogger);
    apiServer.use(bodyParser.json({type: (req) => !req.url.startsWith('/api/webhook/')}));
    apiServer.get('/api/configuration/settings', wrap(async req => configManager.getSettings()));
    apiServer.put('/api/configuration/settings', wrap(async req => configManager.updateSettings(req.body)));

    apiServer.get('/api/configuration/scms', wrap(async req => {
        const res = {};
        const config = configManager.getScmsConfig();
        Array.from(config.keys()).forEach(type => res[type] = config.get(type));
        return res;
    }));

    apiServer.post('/api/configuration/scms/:type', wrap(async req => {
        await configManager.setScm(<common.ScmType> req.params.type, req.body.username, req.body.password, req.body.secret, req.body.repoUrl);
        return {ok: true };
    }));

    apiServer.delete('/api/configuration/scms/:type/:url', wrap(async req => {
        await configManager.removeScm(req.params.type, req.params.url);
        return {ok: true };
    }));
    apiServer.get('/', express.static(__dirname, { index: 'index.html' }));

    return { webHookServer, apiServer, configManager };
}
