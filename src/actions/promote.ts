import * as core from '@actions/core'
import * as deploy from './deploy'
import * as canaryDeploymentHelper from '../strategyHelpers/canary/canaryHelper'
import * as SMICanaryDeploymentHelper from '../strategyHelpers/canary/smiCanaryHelper'
import {
   getResources,
   updateManifestFiles
} from '../utilities/manifestUpdateUtils'
import * as models from '../types/kubernetesTypes'
import * as KubernetesManifestUtility from '../utilities/manifestStabilityUtils'
import {
   deleteGreenObjects,
   getManifestObjects,
   NONE_LABEL_VALUE
} from '../strategyHelpers/blueGreen/blueGreenHelper'

import {BlueGreenManifests} from '../types/blueGreenTypes'

import {
   promoteBlueGreenIngress,
   promoteBlueGreenService,
   promoteBlueGreenSMI
} from '../strategyHelpers/blueGreen/promote'

import {
   routeBlueGreenService,
   routeBlueGreenIngressUnchanged,
   routeBlueGreenSMI
} from '../strategyHelpers/blueGreen/route'

import {cleanupSMI} from '../strategyHelpers/blueGreen/smiBlueGreenHelper'
import {Kubectl, Resource} from '../types/kubectl'
import {DeploymentStrategy} from '../types/deploymentStrategy'
import {
   parseTrafficSplitMethod,
   TrafficSplitMethod
} from '../types/trafficSplitMethod'
import {parseRouteStrategy, RouteStrategy} from '../types/routeStrategy'

export async function promote(
   kubectl: Kubectl,
   manifests: string[],
   deploymentStrategy: DeploymentStrategy
) {
   switch (deploymentStrategy) {
      case DeploymentStrategy.CANARY:
         await promoteCanary(kubectl, manifests)
         break
      case DeploymentStrategy.BLUE_GREEN:
         await promoteBlueGreen(kubectl, manifests)
         break
      default:
         throw Error('Invalid promote deployment strategy')
   }
}

async function promoteCanary(kubectl: Kubectl, manifests: string[]) {
   let includeServices = false

   const trafficSplitMethod = parseTrafficSplitMethod(
      core.getInput('traffic-split-method', {required: true})
   )
   if (trafficSplitMethod == TrafficSplitMethod.SMI) {
      includeServices = true

      // In case of SMI traffic split strategy when deployment is promoted, first we will redirect traffic to
      // canary deployment, then update stable deployment and then redirect traffic to stable deployment
      core.startGroup('Redirecting traffic to canary deployment')
      await SMICanaryDeploymentHelper.redirectTrafficToCanaryDeployment(
         kubectl,
         manifests
      )
      core.endGroup()

      core.startGroup('Deploying input manifests with SMI canary strategy')
      await deploy.deploy(kubectl, manifests, DeploymentStrategy.CANARY)
      core.endGroup()

      core.startGroup('Redirecting traffic to stable deployment')
      await SMICanaryDeploymentHelper.redirectTrafficToStableDeployment(
         kubectl,
         manifests
      )
      core.endGroup()
   } else {
      core.startGroup('Deploying input manifests')
      await deploy.deploy(kubectl, manifests, DeploymentStrategy.CANARY)
      core.endGroup()
   }

   core.startGroup('Deleting canary and baseline workloads')
   try {
      await canaryDeploymentHelper.deleteCanaryDeployment(
         kubectl,
         manifests,
         includeServices
      )
   } catch (ex) {
      core.warning(
         `Exception occurred while deleting canary and baseline workloads: ${ex}`
      )
   }
   core.endGroup()
}

async function promoteBlueGreen(kubectl: Kubectl, manifests: string[]) {
   // update container images and pull secrets
   const inputManifestFiles: string[] = updateManifestFiles(manifests)
   const manifestObjects: BlueGreenManifests =
      getManifestObjects(inputManifestFiles)

   const routeStrategy = parseRouteStrategy(
      core.getInput('route-method', {required: true})
   )

   core.startGroup('Deleting old deployment and making new stable deployment')

   const {deployResult} = await (async () => {
      switch (routeStrategy) {
         case RouteStrategy.INGRESS:
            return await promoteBlueGreenIngress(kubectl, manifestObjects)
         case RouteStrategy.SMI:
            return await promoteBlueGreenSMI(kubectl, manifestObjects)
         default:
            return await promoteBlueGreenService(kubectl, manifestObjects)
      }
   })()

   core.endGroup()

   // checking stability of newly created deployments
   core.startGroup('Checking manifest stability')
   const deployedManifestFiles = deployResult.manifestFiles
   const resources: Resource[] = getResources(
      deployedManifestFiles,
      models.DEPLOYMENT_TYPES.concat([
         models.DiscoveryAndLoadBalancerResource.SERVICE
      ])
   )
   await KubernetesManifestUtility.checkManifestStability(kubectl, resources)
   core.endGroup()

   core.startGroup(
      'Routing to new deployments and deleting old workloads and services'
   )
   if (routeStrategy == RouteStrategy.INGRESS) {
      await routeBlueGreenIngressUnchanged(
         kubectl,
         manifestObjects.serviceNameMap,
         manifestObjects.ingressEntityList
      )

      await deleteGreenObjects(
         kubectl,
         [].concat(
            manifestObjects.deploymentEntityList,
            manifestObjects.serviceEntityList
         )
      )
   } else if (routeStrategy == RouteStrategy.SMI) {
      await routeBlueGreenSMI(
         kubectl,
         NONE_LABEL_VALUE,
         manifestObjects.serviceEntityList
      )
      await deleteGreenObjects(kubectl, manifestObjects.deploymentEntityList)
      await cleanupSMI(kubectl, manifestObjects.serviceEntityList)
   } else {
      await routeBlueGreenService(
         kubectl,
         NONE_LABEL_VALUE,
         manifestObjects.serviceEntityList
      )
      await deleteGreenObjects(kubectl, manifestObjects.deploymentEntityList)
   }
   core.endGroup()
}
