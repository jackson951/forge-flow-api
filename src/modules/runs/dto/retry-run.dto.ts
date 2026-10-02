import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class RetryRunDto {
  @ApiPropertyOptional({
    description:
      'Reuse the stored outputs of steps that succeeded, so completed side effects are not repeated',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  resumeFromFailedStep?: boolean;

  @ApiPropertyOptional({
    description:
      'Required when the failed step ended with UNCERTAIN_OUTCOME: confirms you checked the provider and accept a possible duplicate',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeUncertainOutcome?: boolean;
}
