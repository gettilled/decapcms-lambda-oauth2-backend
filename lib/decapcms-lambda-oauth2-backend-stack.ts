import * as cdk from "aws-cdk-lib";
import { EndpointType, LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export class DecapCMSLambdaOauth2BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const docsVpcID = ssm.StringParameter.valueFromLookup(this, "/tilled-docs/DOCS_VPC_ID");
    const docsVpcEndpointSecGrpID = ssm.StringParameter.valueFromLookup(this, "/tilled-docs/DOCS_VPC_ENDPOINT_SG_ID");
    const docsVpcEndpointSubnetID1 = ssm.StringParameter.valueFromLookup(this, "/tilled-docs/DOCS_VPC_ENDPOINT_SUBNET1");
    const docsVpcEndpointSubnetID2 = ssm.StringParameter.valueFromLookup(this, "/tilled-docs/DOCS_VPC_ENDPOINT_SUBNET2");


    const defaultPathFunction = new NodejsFunction(this, "lambda", {
      entry: "src/index.ts",
      handler: "handler",
      runtime: Runtime.NODEJS_18_X,
    });

    const iamRoleForLambda = new iam.Role(this, "SSMSecureStringLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMReadOnlyAccess"),
      ],
    });

    const authFunction = new NodejsFunction(this, "AuthFunction", {
      entry: "src/auth.ts",
      handler: "handler",
      runtime: Runtime.NODEJS_18_X,
      role: iamRoleForLambda,
      environment: {
        OAUTH_GITHUB_CLIENT_ID: "",
        OAUTH_GITHUB_CLIENT_SECRET: "",
      },
    });
    const callbackFunction = new NodejsFunction(this, "CallbackFunction", {
      entry: "src/callback.ts",
      handler: "handler",
      runtime: Runtime.NODEJS_18_X,
      role: iamRoleForLambda,
      environment: {
        OAUTH_GITHUB_CLIENT_ID: "",
        OAUTH_GITHUB_CLIENT_SECRET: "",
      },
    });

    const vpcDocs = ec2.Vpc.fromLookup(this, 'DocsVPC', {
      //vpcId: "vpc-05d77c78d18599b47"
      vpcId: docsVpcID
    })

    const docsVpcEndpointSecGrp = ec2.SecurityGroup.fromLookupById(this, "DocsSecurityGroup", docsVpcEndpointSecGrpID)

    const docsVpcEndpointSubnet1 = ec2.Subnet.fromSubnetId(this, "DocsSubnet1", docsVpcEndpointSubnetID1)
    const docsVpcEndpointSubnet2 = ec2.Subnet.fromSubnetId(this, "DocsSubnet2", docsVpcEndpointSubnetID2)

    const restApiVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, "DocsRestApiVpcEndpoint", {
      vpc: vpcDocs,
      service: {
        name: `com.amazonaws.${this.region}.execute-api`,
        port: 443
      },
      subnets: {
        subnets: [docsVpcEndpointSubnet1, docsVpcEndpointSubnet2]
      },
      privateDnsEnabled: true,
      securityGroups: [docsVpcEndpointSecGrp]
    })


    const api = new LambdaRestApi(this, "OAuth2BackendAPI", {
      handler: defaultPathFunction,
      proxy: false,
      endpointConfiguration: {
        types: [EndpointType.PRIVATE],
        vpcEndpoints:[restApiVpcEndpoint],
      },
      policy: new iam.PolicyDocument({
        statements: [
            new iam.PolicyStatement({
                principals: [new iam.AnyPrincipal()],
                actions: ['execute-api:Invoke'],
                resources: ['execute-api:/*'],
                effect: iam.Effect.DENY,
                conditions: {
                    StringNotEquals: {
                        'aws:SourceVpce': restApiVpcEndpoint.vpcEndpointId,
                    },
                },
            }),
            new iam.PolicyStatement({
                principals: [new iam.AnyPrincipal()],
                actions: ['execute-api:Invoke'],
                resources: ['execute-api:/*'],
                effect: iam.Effect.ALLOW,
            }),
        ],
    }),
    });

    const auth = api.root.addResource("auth");
    auth.addMethod("GET", new cdk.aws_apigateway.LambdaIntegration(authFunction));

    const callback = api.root.addResource("callback");
    callback.addMethod("GET", new cdk.aws_apigateway.LambdaIntegration(callbackFunction));

    new cdk.CfnOutput(this, "authpath", {
      value: api.url + "auth",
      description: "auth",
    });
    new cdk.CfnOutput(this, "callbackpath", {
      value: api.url + "callback",
      description: "callback",
    });
  }
}
